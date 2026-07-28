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

      if (error) ignores++;
      else ajoutes++;
    }

    res.json({ trouves: permis.length, ajoutes, ignores, exclusPro });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Zolva backend actif ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur Zolva backend démarré sur le port ${PORT}`));
