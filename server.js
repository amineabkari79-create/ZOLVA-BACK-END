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

// Le serveur Overpass principal (overpass-api.de) est communautaire et souvent surchargé
// ("server too busy"). On garde plusieurs miroirs équivalents et on bascule automatiquement
// sur le suivant si l'un d'eux timeout ou est indisponible.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter'
];
const BAN_REVERSE_URL = 'https://api-adresse.data.gouv.fr/reverse/';
const BAN_SEARCH_URL = 'https://api-adresse.data.gouv.fr/search/';

// --- Fonction : convertir un nom de ville en coordonnées GPS (API BAN, gratuite) ---
async function geocoderVille(ville) {
  const url = `${BAN_SEARCH_URL}?q=${encodeURIComponent(ville)}&type=municipality&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Géocodage de la ville échoué (' + res.status + ')');
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new Error(`Ville "${ville}" introuvable`);
  const [lon, lat] = feature.geometry.coordinates;
  return { lat, lon };
}

// ============================================================
// ACCÈS BÊTA — codes d'accès partagés (pas de vrais comptes, juste un filtre)
// ============================================================
// ACCESS_CODES = variable d'environnement Render, format : "CODE1,CODE2,CODE3"
const ACCESS_CODES = (process.env.ACCESS_CODES || '').split(',').map(s => s.trim()).filter(Boolean);

function checkAccessCode(req, res, next) {
  const code = req.header('x-access-code');
  if (!code || !ACCESS_CODES.includes(code)) {
    return res.status(401).json({ error: 'Code d\'accès invalide ou manquant' });
  }
  req.owner = code; // sert à cloisonner les données de chaque testeur
  next();
}

// Vérifie qu'un code est valide (appelé par l'écran de connexion du front)
app.get('/api/auth/check', checkAccessCode, (req, res) => {
  res.json({ ok: true, owner: req.owner });
});

// Protège le job cron (/api/relances/run) avec un secret différent des codes d'accès,
// puisqu'il est appelé par un service externe (cron-job.org), pas par un utilisateur connecté.
function checkCronSecret(req, res, next) {
  const secret = req.header('x-cron-secret') || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// --- Fonction : interroger Overpass pour une ville donnée (avec bascule automatique sur les miroirs) ---
async function chercherPiscines(ville) {
  // On géolocalise la ville en coordonnées GPS puis on cherche dans un rayon autour,
  // plutôt que de chercher par nom de zone administrative : cette dernière méthode dépend
  // d'un index ("area") qui n'est pas toujours à jour ou disponible de façon identique sur
  // tous les serveurs Overpass, ce qui pouvait renvoyer 0 résultat sans aucune erreur.
  const { lat, lon } = await geocoderVille(ville);
  const rayon = 12000; // 12 km autour du centre-ville — couvre la commune et ses environs proches
  const query = `
    [out:json][timeout:25];
    (
      way["leisure"="swimming_pool"](around:${rayon},${lat},${lon});
      relation["leisure"="swimming_pool"](around:${rayon},${lat},${lon});
    );
    out center;
  `;

  let derniereErreur = null;
  for (const url of OVERPASS_URLS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 28000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: query,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) { derniereErreur = new Error(`${url} a répondu ${res.status}`); continue; }

      const data = await res.json();
      // Overpass renvoie parfois du 200 OK avec un message d'erreur dans le corps (serveur surchargé)
      if (data.remark && /error|timeout|too busy/i.test(data.remark)) {
        derniereErreur = new Error(`${url} : ${data.remark}`);
        continue;
      }
      return data.elements || [];
    } catch (err) {
      derniereErreur = err;
      // on essaie le miroir suivant
    }
  }
  throw derniereErreur || new Error('Tous les serveurs Overpass sont indisponibles');
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
app.post('/api/scan', checkAccessCode, async (req, res) => {
  const { ville, force } = req.body;
  if (!ville) return res.status(400).json({ error: 'Le paramètre "ville" est requis' });

  try {
    // Si cette zone a déjà été scannée récemment par ce testeur, on ne refait pas tout le travail —
    // on renvoie directement ce qui est déjà en base (rapide).
    if (!force) {
      const { count } = await supabase
        .from('prospects')
        .select('*', { count: 'exact', head: true })
        .eq('owner', req.owner)
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
        owner: req.owner,
        latitude: lat,
        longitude: lon,
        adresse: adresseInfo?.adresse ?? null,
        code_postal: adresseInfo?.code_postal ?? null,
        ville: adresseInfo?.ville ?? ville,
        zone_recherche: ville
      }, { onConflict: 'osm_id,owner' });

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
app.get('/api/prospects', checkAccessCode, async (req, res) => {
  const { ville, categorie, limit = 50 } = req.query;

  let q = supabase.from('prospects').select('*').eq('owner', req.owner).order('created_at', { ascending: false }).limit(Number(limit));
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
    throw new Error(`PermisAPI a répondu avec le statut ${res.status}`);
  }
  const data = await res.json();
  return data.data || [];
}

// --- Route : scanner un département pour les maisons individuelles neuves ---
app.post('/api/scan-maisons', checkAccessCode, async (req, res) => {
  const { dep_code, force } = req.body;
  if (!dep_code) return res.status(400).json({ error: 'Le paramètre "dep_code" est requis (ex: 33)' });
  if (!process.env.PERMISAPI_KEY) return res.status(500).json({ error: 'PERMISAPI_KEY non configurée côté serveur' });

  try {
    if (!force) {
      const { count } = await supabase
        .from('prospects')
        .select('*', { count: 'exact', head: true })
        .eq('categorie', 'maison_neuve')
        .eq('owner', req.owner)
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
        owner: req.owner,
        categorie: 'maison_neuve',
        latitude: p.lat,
        longitude: p.lng,
        adresse: p.full_address,
        ville: p.adr_localite_ter,
        zone_recherche: dep_code,
        superficie_terrain: p.superficie_terrain || null,
        date_autorisation: p.date_reelle_autorisation || null,
        source: 'permisapi_maison_neuve'
      }, { onConflict: 'num_pa,owner' });

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
// GÉNÉRATION DE TEXTE IA — passe-plat générique et sécurisé vers Claude
// ============================================================
app.post('/api/ai-generate', checkAccessCode, async (req, res) => {
  const { system, prompt, maxTokens, history } = req.body;
  if (!prompt && !history) return res.status(400).json({ error: 'prompt requis' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });

  try {
    const messages = history && history.length ? history : [{ role: 'user', content: prompt }];
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: maxTokens || 600,
        ...(system ? { system } : {}),
        messages
      })
    });
    if (!resp.ok) throw new Error('Anthropic a répondu ' + resp.status);
    const data = await resp.json();
    res.json({ text: data.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ESTIMATION IMMOBILIÈRE RÉELLE — DVF (Demandes de Valeurs Foncières, DGFiP)
// ============================================================
app.get('/api/valeur-immo', checkAccessCode, async (req, res) => {
  const { lat, lon, dist } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat et lon sont requis' });

  try {
    const rayon = dist || 1500; // mètres — élargi si pas assez de résultats
    const url = `https://api.cquest.org/dvf?lat=${lat}&lon=${lon}&dist=${rayon}&type_local=Maison`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('DVF a répondu ' + r.status);
    const data = await r.json();
    const features = data.features || [];

    // On ne garde que les ventes exploitables : maison, prix et surface renseignés et cohérents
    const ventes = features
      .map(f => f.properties)
      .filter(p => p.valeur_fonciere && p.surface_reelle_bati && p.surface_reelle_bati > 20)
      .map(p => ({
        prix: Number(p.valeur_fonciere),
        surface: Number(p.surface_reelle_bati),
        prixM2: Number(p.valeur_fonciere) / Number(p.surface_reelle_bati),
        date: p.date_mutation,
        adresse: [p.adresse_numero, p.adresse_nom_voie].filter(Boolean).join(' ')
      }))
      .filter(v => v.prixM2 > 500 && v.prixM2 < 15000); // écarte les valeurs aberrantes (erreurs de saisie DVF)

    if (ventes.length === 0) {
      return res.json({ trouve: false, message: 'Aucune vente comparable trouvée à proximité dans la base DVF' });
    }

    const prixM2Tries = ventes.map(v => v.prixM2).sort((a, b) => a - b);
    const prixM2Median = prixM2Tries[Math.floor(prixM2Tries.length / 2)];

    res.json({
      trouve: true,
      prixM2Median: Math.round(prixM2Median),
      nbTransactions: ventes.length,
      rayonMetres: Number(rayon),
      exemples: ventes.slice(0, 5),
      source: 'DVF — DGFiP (data.gouv.fr)'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
        owner: business?.owner || null,
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
async function envoyerEmail(to, subject, body, fromName, replyTo) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY non configurée');
  const nom = (fromName || 'Zolva').replace(/[<>]/g, '');
  const payload = {
    from: `${nom} <onboarding@resend.dev>`,
    to: [to],
    subject,
    html: body.replace(/\n/g, '<br>')
  };
  // Le mail part toujours de l'adresse partagée Zolva (nécessaire tant qu'aucun domaine
  // propre n'est vérifié sur Resend), mais une réponse du prospect atterrit directement
  // dans la boîte mail réelle du pisciniste grâce au reply-to.
  if (replyTo) payload.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
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
app.post('/api/send-email', checkAccessCode, async (req, res) => {
  const { to, subject, body, fromName, replyTo } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject et body sont requis' });
  try {
    await envoyerEmail(to, subject, body, fromName, replyTo);
    res.json({ envoye: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Route : envoi manuel d'un SMS ---
app.post('/api/send-sms', checkAccessCode, async (req, res) => {
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
app.post('/api/relances/activer', checkAccessCode, async (req, res) => {
  const { prospect_local_id, nom, tel, email, canal_prefere, ville, date_contact, entreprise_nom, cal_link, style, reply_to } = req.body;
  if (!prospect_local_id) return res.status(400).json({ error: 'prospect_local_id requis' });
  if (!tel && !email) return res.status(400).json({ error: 'Un téléphone ou un email est requis pour automatiser les relances' });

  const { error } = await supabase.from('relances_auto').upsert({
    prospect_local_id,
    owner: req.owner,
    nom, tel, email,
    canal_prefere: canal_prefere || (tel ? 'sms' : 'email'),
    ville,
    date_contact: date_contact || new Date().toISOString().slice(0, 10),
    entreprise_nom: entreprise_nom || null,
    cal_link: cal_link || null,
    reply_to: reply_to || null,
    style: style || 'naturel',
    step: 'j1',
    statut: 'actif'
  }, { onConflict: 'prospect_local_id,owner' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ active: true });
});

// --- Désactiver le suivi automatique ---
app.post('/api/relances/desactiver', checkAccessCode, async (req, res) => {
  const { prospect_local_id } = req.body;
  if (!prospect_local_id) return res.status(400).json({ error: 'prospect_local_id requis' });
  const { error } = await supabase.from('relances_auto').update({ statut: 'desactive' }).eq('prospect_local_id', prospect_local_id).eq('owner', req.owner);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ desactive: true });
});

// --- Lister les prospects sous suivi automatique (pour affichage dans l'app) ---
app.get('/api/relances/liste', checkAccessCode, async (req, res) => {
  const { data, error } = await supabase.from('relances_auto').select('*').eq('owner', req.owner).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Générer un message de relance via Claude (réutilisé par le job auto) ---
function styleInstruction(style) {
  const map = {
    naturel: 'Ton naturel et neutre, sans technique de vente appuyée.',
    soft_fomo: 'Utilise une technique de "soft FOMO" SANS mentir : évoque que d\'autres propriétaires du secteur avancent sur leur projet, reste crédible, jamais de fausse urgence artificielle.',
    soft_urgence: 'Urgence douce et réelle liée à la saisonnalité (délais de construction avant l\'été) — factuel, jamais agressif.',
    storytelling: 'Utilise un mini-récit concret (client fictif mais réaliste, prénom + détail précis) pour illustrer le bénéfice.',
    direct: 'Va droit au but, phrases courtes, une seule idée par message.'
  };
  return map[style] || map.naturel;
}

async function genererMessageRelance(step, prospect) {
  const entreprise = prospect.entreprise_nom || 'notre entreprise';
  const calLink = prospect.cal_link || '[lien de RDV non configuré]';
  const styleInstr = styleInstruction(prospect.style);
  const isSms = prospect.canal_prefere === 'sms';
  const contrainteFormat = isSms
    ? 'Format SMS strict : 300 caractères maximum, une seule idée, le lien de RDV DOIT être inclus explicitement.'
    : 'Format email : 3-5 phrases, le lien de RDV inclus naturellement.';

  const prompts = {
    j1: `Tu rédiges au nom de "${entreprise}" (jamais de prénom fictif type "Thomas"). Message de relance J+1 pour ${prospect.nom || 'le prospect'}, contacté récemment pour un projet piscine, sans réponse. ${styleInstr} ${contrainteFormat} Objectif : obtenir un rendez-vous via ce lien : ${calLink}. Réponds uniquement avec le message.`,
    j2: `Tu rédiges au nom de "${entreprise}". Message de relance J+2 pour ${prospect.nom || 'le prospect'} (région : ${prospect.ville || 'sa région'}). ${styleInstr} ${contrainteFormat} Objectif : obtenir un rendez-vous via ce lien : ${calLink}. Réponds uniquement avec le message.`,
    j3: `Tu rédiges au nom de "${entreprise}". Dernier message de relance J+3 pour ${prospect.nom || 'le prospect'}. ${styleInstr} ${contrainteFormat} Objectif : obtenir un rendez-vous via ce lien : ${calLink}. Réponds uniquement avec le message.`
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
app.post('/api/relances/run', checkCronSecret, async (req, res) => {
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
          await envoyerEmail(p.email, 'Votre projet piscine', message, p.entreprise_nom, p.reply_to);
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
