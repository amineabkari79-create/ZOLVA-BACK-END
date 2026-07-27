# Zolva Backend — Détection piscines (OpenStreetMap)

## Ce que fait ce backend
- `POST /api/scan` avec `{ "ville": "Bordeaux" }` → cherche les piscines OSM dans cette ville, récupère l'adresse approximative, stocke dans Supabase.
- `GET /api/prospects?ville=Bordeaux` → retourne les prospects stockés (c'est cette route que Zolva appellera).

## Déploiement sur Render (étapes)

1. Crée un dépôt GitHub (github.com → "New repository", nom libre ex. `zolva-backend`, laisse-le vide, pas de README auto).
2. Mets ces 3 fichiers (`server.js`, `package.json`, ce README) dans ce dépôt — le plus simple : sur la page du repo GitHub, clique "Add file" → "Upload files", glisse les 3 fichiers, puis "Commit changes".
3. Sur Render : "New" → "Web Service" → connecte ton compte GitHub → choisis le dépôt `zolva-backend`.
4. Configuration du service :
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
5. Dans l'onglet "Environment" du service Render, ajoute 2 variables :
   - `SUPABASE_URL` = ton Project URL Supabase
   - `SUPABASE_SERVICE_KEY` = ta service_role key Supabase
6. Clique "Create Web Service". Le déploiement prend 2-3 minutes.
7. Une fois déployé, Render te donne une URL du type `https://zolva-backend-xxxx.onrender.com`.

## Tester

Une fois en ligne, dans un terminal ou Postman :
```
curl -X POST https://TON-URL.onrender.com/api/scan -H "Content-Type: application/json" -d '{"ville":"Bordeaux"}'
```
Puis vérifie dans Supabase (Table Editor → prospects) que des lignes sont apparues.

Note : le plan gratuit Render "s'endort" après 15 min d'inactivité et met ~30s à se réveiller au premier appel suivant. Normal, pas un bug.
