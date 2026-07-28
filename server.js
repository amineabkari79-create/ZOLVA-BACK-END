import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Connexion Supabase ---
// Ces deux valeurs viennent des variables d'environnement (configurées sur Render, jamais écrites en dur ici)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const BAN_REVERSE_URL = 'https://api-adresse.data.gouv.fr/reverse/';

// --- Fonction : interroger Overpass pour une ville donnée ---
async function chercherPiscines(ville) {
  const query = `
    [out:json][timeout:50];
    area["name"="${ville}"]["boundary"="administrative"]->.a;
    (
      way["leisure"="swimming_pool"](area.a);
      relation["leisure"="swimming_pool"](area.a);
    );
    out center;
  `;

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: query
  });

  if (!res.ok) {
    throw new Error(`Overpass a répondu avec le statut ${res.status}`);
  }

  const data = await res.json();
  return data.elements || [];
}

// --- Fonction : retrouver l'adresse approximative d'une coordonnée (API BAN, gratuite) ---
async function reverseGeocode(lat, lon) {
  try {
    const url = `${BAN_REVERSE_URL}?lon=${lon}&lat=${lat}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const feature = data.features?.[0];
    if (!feature) return null;
    return {
      adresse: feature.properties.label,
      code_postal: feature.properties.postcode,
      ville: feature.properties.city
    };
  } catch {
    return null; // si le reverse geocoding échoue pour un point, on continue sans bloquer le reste
  }
}

// --- Route : lancer une recherche pour une ville et stocker les résultats ---
app.post('/api/scan', async (req, res) => {
  const { ville, force } = req.body;
  if (!ville) return res.status(400).json({ error: 'Le paramètre "ville" est requis' });

  try {
    // Si cette zone a déjà été scannée récemment, on ne refait pas tout le travail —
    // on renvoie directement ce qui est déjà en base (rapide).
    if (!force) {
      const { count } = await supabase
        .from('prospects')
        .select('*', { count: 'exact', head: true })
        .ilike('zone_recherche', ville);

      if (count && count > 0) {
        return res.json({ dejaScanne: true, enBase: count, message: 'Zone déjà scannée, données existantes utilisées' });
      }
    }

    const elements = await chercherPiscines(ville);
    let ajoutes = 0;
    let ignores = 0;

    for (const el of elements) {
      const lat = el.center?.lat ?? el.lat;
      const lon = el.center?.lon ?? el.lon;
      if (!lat || !lon) continue;

      const adresseInfo = await reverseGeocode(lat, lon);

      const { error } = await supabase.from('prospects').upsert({
        osm_id: el.id,
        latitude: lat,
        longitude: lon,
        adresse: adresseInfo?.adresse ?? null,
        code_postal: adresseInfo?.code_postal ?? null,
        ville: adresseInfo?.ville ?? ville,
        zone_recherche: ville
      }, { onConflict: 'osm_id' });

      if (error) ignores++;
      else ajoutes++;

      // petite pause pour ne pas surcharger l'API gratuite de géocodage
      await new Promise(r => setTimeout(r, 150));
    }

    res.json({ trouves: elements.length, ajoutes, ignores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Route : lister les prospects stockés (celle que Zolva va appeler) ---
app.get('/api/prospects', async (req, res) => {
  const { ville, categorie, limit = 50 } = req.query;

  let q = supabase.from('prospects').select('*').order('created_at', { ascending: false }).limit(Number(limit));
  if (ville) q = q.or(`ville.ilike.%${ville}%,zone_recherche.ilike.%${ville}%`);
  if (categorie) q = q.eq('categorie', categorie);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PERMISAPI_URL = 'https://api.permisapi.fr/v1/permits';

// --- Fonction : interroger PermisAPI pour les maisons individuelles neuves d'un département ---
async function chercherMaisonsNeuves(depCode) {
  const url = `${PERMISAPI_URL}?dep_code=${encodeURIComponent(depCode)}&permit_type=PC_LOGEMENT`;
  const res = await fetch(url, {
    headers: { 'X-API-Key': process.env.PERMISAPI_KEY }
  });
  if (!res.ok) {
    const key = process.env.PERMISAPI_KEY || '';
    throw new Error(`PermisAPI a répondu avec le statut ${res.status} — clé reçue : longueur=${key.length}, début="${key.slice(0, 8)}", fin="${key.slice(-4)}"`);
  }
  const data = await res.json();
  return data.data || [];
}

// --- Route : scanner un département pour les maisons individuelles neuves ---
app.post('/api/scan-maisons', async (req, res) => {
  const { dep_code, force } = req.body;
  if (!dep_code) return res.status(400).json({ error: 'Le paramètre "dep_code" est requis (ex: 33)' });
  if (!process.env.PERMISAPI_KEY) return res.status(500).json({ error: 'PERMISAPI_KEY non configurée côté serveur' });

  try {
    if (!force) {
      const { count } = await supabase
        .from('prospects')
        .select('*', { count: 'exact', head: true })
        .eq('categorie', 'maison_neuve')
        .ilike('zone_recherche', dep_code);

      if (count && count > 0) {
        return res.json({ dejaScanne: true, enBase: count, message: 'Département déjà scanné, données existantes utilisées' });
      }
    }

    const permis = await chercherMaisonsNeuves(dep_code);
    let ajoutes = 0, ignores = 0, exclusPro = 0;
    let premiereErreur = null;

    for (const p of permis) {
      // On exclut les demandeurs professionnels (promoteurs, aménageurs) : leur nom (denom_dem)
      // ou un SIREN renseigné indique une société, pas un particulier qui décidera lui-même d'une piscine.
      if (p.denom_dem || p.siren_dem) { exclusPro++; continue; }
      if (!p.full_address) { ignores++; continue; }

      const { error } = await supabase.from('prospects').upsert({
        num_pa: p.num_pa,
        categorie: 'maison_neuve',
        latitude: p.lat,
        longitude: p.lng,
        adresse: p.full_address,
        ville: p.adr_localite_ter,
        zone_recherche: dep_code,
        superficie_terrain: p.superficie_terrain || null,
        date_autorisation: p.date_reelle_autorisation || null,
        source: 'permisapi_maison_neuve'
      }, { onConflict: 'num_pa' });

      if (error) { ignores++; if (!premiereErreur) premiereErreur = error.message; }
      else ajoutes++;
    }

    res.json({ trouves: permis.length, ajoutes, ignores, exclusPro, premiereErreur });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Zolva backend actif ✓'));

// ============================================================
// CHATBOT PUBLIC — widget de setting pour le site du pisciniste
// ============================================================
function buildSystemPrompt(business) {
  const nom = business?.nom || 'notre entreprise';
  const tel = business?.tel || '[téléphone non renseigné]';
  const services = business?.services || 'installation, entretien et rénovation de piscines';

  return `Tu es l'assistant de prise de rendez-vous de "${nom}", une entreprise spécialisée en ${services}. Tu discutes avec un visiteur du site web, pas un collègue.

TON RÔLE (setting, pas vente technique poussée) :
- Répondre aux questions générales et objections courantes (prix, délais, confiance, "est-ce vraiment gratuit ?") de façon rassurante et concise
- Ne JAMAIS donner de prix précis (tu n'as pas cette info) — orienter vers "ça dépend du projet, un diagnostic gratuit permet de chiffrer précisément"
- Ton objectif unique : obtenir un rendez-vous de diagnostic gratuit
- Dès que la personne semble intéressée, demander son prénom, un téléphone ou email, et un créneau qui l'arrange

STYLE : phrases courtes, chaleureux mais pas familier, jamais insistant. Une question à la fois.

FORMAT DE RÉPONSE — IMPORTANT :
Réponds normalement en français. Si, et seulement si, tu as obtenu au minimum un prénom ET un moyen de contact (téléphone ou email) dans cet échange, termine ta réponse par un bloc cette forme exacte sur sa propre ligne (invisible pour l'utilisateur, ne le mentionne jamais) :
<LEAD>{"nom":"...","tel":"...","email":"...","resume":"une phrase résumant le besoin"}</LEAD>
Si tu n'as pas ces informations, n'inclus aucun bloc <LEAD>.`;
}

app.post('/api/chat-widget', async (req, res) => {
  const { message, history, business } = req.body;
  if (!message) return res.status(400).json({ error: 'Le paramètre "message" est requis' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée côté serveur' });

  try {
    const messages = [...(history || []), { role: 'user', content: message }];

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 400,
        system: buildSystemPrompt(business),
        messages
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic API a répondu ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    let reply = data.content[0].text;

    // Extraction discrète du lead si présent, sans le montrer au visiteur
    let lead = null;
    const match = reply.match(/<LEAD>([\s\S]*?)<\/LEAD>/);
    if (match) {
      try { lead = JSON.parse(match[1]); } catch (e) { /* JSON mal formé, on ignore */ }
      reply = reply.replace(/<LEAD>[\s\S]*?<\/LEAD>/, '').trim();
    }

    if (lead && (lead.tel || lead.email)) {
      await supabase.from('prospects').insert({
        categorie: 'widget_lead',
        contact_nom: lead.nom || null,
        contact_tel: lead.tel || null,
        contact_email: lead.email || null,
        resume_conversation: lead.resume || null,
        ville: business?.nom || null,
        zone_recherche: 'chatbot_public',
        source: 'chat_widget'
      });
    }

    res.json({ reply, leadCaptured: !!lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ENVOI RÉEL — email (Resend) et SMS (Twilio)
// ============================================================
async function envoyerEmail(to, subject, body) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY non configurée');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Zolva <onboarding@resend.dev>',
      to: [to],
      subject,
      html: body.replace(/\n/g, '<br>')
    })
  });
  if (!res.ok) throw new Error('Resend a répondu ' + res.status + ': ' + await res.text());
  return await res.json();
}

async function envoyerSMS(to, body) {
  if (!process.env.TWILIO_SID || !process.env.TWILIO_TOKEN || !process.env.TWILIO_FROM) {
    throw new Error('Variables Twilio non configurées (TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM)');
  }
  const auth = Buffer.from(process.env.TWILIO_SID + ':' + process.env.TWILIO_TOKEN).toString('base64');
  const params = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  if (!res.ok) throw new Error('Twilio a répondu ' + res.status + ': ' + await res.text());
  return await res.json();
}

// --- Route : envoi manuel d'un email (bouton "Envoyer" côté app) ---
app.post('/api/send-email', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject et body sont requis' });
  try {
    await envoyerEmail(to, subject, body);
    res.json({ envoye: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Route : envoi manuel d'un SMS ---
app.post('/api/send-sms', async (req, res) => {
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'to et body sont requis' });
  try {
    await envoyerSMS(to, body);
    res.json({ envoye: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// RELANCES AUTOMATIQUES
// ============================================================

// --- Activer le suivi automatique pour un prospect ---
app.post('/api/relances/activer', async (req, res) => {
  const { prospect_local_id, nom, tel, email, canal_prefere, ville, date_contact } = req.body;
  if (!prospect_local_id) return res.status(400).json({ error: 'prospect_local_id requis' });
  if (!tel && !email) return res.status(400).json({ error: 'Un téléphone ou un email est requis pour automatiser les relances' });

  const { error } = await supabase.from('relances_auto').upsert({
    prospect_local_id, nom, tel, email,
    canal_prefere: canal_prefere || (tel ? 'sms' : 'email'),
    ville,
    date_contact: date_contact || new Date().toISOString().slice(0, 10),
    step: 'j1',
    statut: 'actif'
  }, { onConflict: 'prospect_local_id' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ active: true });
});

// --- Désactiver le suivi automatique ---
app.post('/api/relances/desactiver', async (req, res) => {
  const { prospect_local_id } = req.body;
  if (!prospect_local_id) return res.status(400).json({ error: 'prospect_local_id requis' });
  const { error } = await supabase.from('relances_auto').update({ statut: 'desactive' }).eq('prospect_local_id', prospect_local_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ desactive: true });
});

// --- Lister les prospects sous suivi automatique (pour affichage dans l'app) ---
app.get('/api/relances/liste', async (req, res) => {
  const { data, error } = await supabase.from('relances_auto').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Générer un message de relance via Claude (réutilisé par le job auto) ---
async function genererMessageRelance(step, prospect) {
  const prompts = {
    j1: `Tu es Thomas, setter piscine terrain. Rédige un message de relance J+1 ultra-naturel pour ${prospect.nom || 'le prospect'}. Il a été contacté récemment pour un projet piscine et n'a pas répondu. Style humain, pas commercial, comme si tu vérifies juste qu'il a bien reçu. 3-4 phrases max. Réponds uniquement avec le message, sans lien ni signature.`,
    j2: `Tu es Thomas, setter piscine terrain. Rédige un message de relance J+2 pour ${prospect.nom || 'le prospect'}. Utilise une preuve sociale : un témoignage fictif mais réaliste d'un propriétaire satisfait dans la région de ${prospect.ville || 'sa région'}. 4-5 phrases max. Réponds uniquement avec le message.`,
    j3: `Tu es Thomas, setter piscine terrain. Rédige le dernier message de relance J+3 pour ${prospect.nom || 'le prospect'}. Créé une urgence réelle sur la saison de construction. Ton direct mais respectueux. 4 phrases max. Réponds uniquement avec le message.`
  };
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY non configurée');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompts[step] }]
    })
  });
  if (!resp.ok) throw new Error('Anthropic a répondu ' + resp.status);
  const data = await resp.json();
  return data.content[0].text;
}

// --- Job quotidien : à déclencher par un service de cron externe (ex: cron-job.org) ---
app.post('/api/relances/run', async (req, res) => {
  try {
    const { data: actifs, error } = await supabase.from('relances_auto').select('*').eq('statut', 'actif');
    if (error) throw error;

    const nextStep = { j1: 'j2', j2: 'j3', j3: null };
    const delaiJours = { j1: 1, j2: 2, j3: 3 }; // jours depuis date_contact avant de déclencher chaque étape
    let traites = 0, envoyes = 0, erreurs = 0;

    for (const p of actifs) {
      const refDate = new Date(p.date_contact);
      const joursEcoules = Math.floor((Date.now() - refDate.getTime()) / 86400000);
      const seuil = delaiJours[p.step];

      // Pas encore l'heure de cette étape, ou déjà relancé aujourd'hui
      if (joursEcoules < seuil) continue;
      if (p.derniere_relance && new Date(p.derniere_relance).toDateString() === new Date().toDateString()) continue;

      traites++;
      try {
        const message = await genererMessageRelance(p.step, p);
        if (p.canal_prefere === 'sms' && p.tel) {
          await envoyerSMS(p.tel, message);
        } else if (p.email) {
          await envoyerEmail(p.email, 'Votre projet piscine', message);
        } else {
          throw new Error('Aucun canal disponible');
        }

        const suivant = nextStep[p.step];
        await supabase.from('relances_auto').update({
          step: suivant || p.step,
          statut: suivant ? 'actif' : 'termine',
          derniere_relance: new Date().toISOString()
        }).eq('id', p.id);

        envoyes++;
      } catch (e) {
        erreurs++;
        console.error('Erreur relance pour', p.prospect_local_id, e.message);
      }
    }

    res.json({ verifies: actifs.length, traites, envoyes, erreurs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur Zolva backend démarré sur le port ${PORT}`));
