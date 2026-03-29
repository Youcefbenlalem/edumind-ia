const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/edumind')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── MODELS ──
const UserSchema = new mongoose.Schema({
  firstName:      { type: String, required: true },
  lastName:       { type: String, required: true },
  email:          { type: String, required: true, unique: true, lowercase: true },
  password:       { type: String, required: true },
  friends:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  compareVisible: { type: Boolean, default: true },
  createdAt:      { type: Date, default: Date.now },
});
const User = mongoose.model('User', UserSchema);

const FriendRequestSchema = new mongoose.Schema({
  from:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:    { type: String, enum: ['pending','accepted','declined'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
});
const FriendRequest = mongoose.model('FriendRequest', FriendRequestSchema);

const QuizResultSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  annee:   String, filiere: String, matiere: String, lecon: String,
  score:   Number, total: Number,
  points:  { type: Number, default: 0 },
  date:    { type: Date, default: Date.now },
});
const QuizResult = mongoose.model('QuizResult', QuizResultSchema);

// ── AUTH MIDDLEWARE ──
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Non authentifié' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'edumind_secret');
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return res.status(401).json({ message: 'Utilisateur introuvable' });
    next();
  } catch { res.status(401).json({ message: 'Token invalide' }); }
};
const signToken = id => jwt.sign({ id }, process.env.JWT_SECRET || 'edumind_secret', { expiresIn: '30d' });

// ── AUTH ROUTES ──
app.post('/api/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    if (!firstName || !lastName || !email || !password)
      return res.status(400).json({ message: 'Tous les champs sont obligatoires' });
    if (await User.findOne({ email }))
      return res.status(400).json({ message: 'Email déjà utilisé' });
    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({ firstName, lastName, email, password: hashed });
    res.status(201).json({ token: signToken(user._id), user: { id: user._id, firstName, lastName, email } });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(400).json({ message: 'Email ou mot de passe incorrect' });
    res.json({ token: signToken(user._id), user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email } });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// ── STATS ──
app.get('/api/stats', auth, async (req, res) => {
  try {
    const results = await QuizResult.find({ userId: req.user._id });
    const totalPoints = results.reduce((s, r) => s + (r.points || 0), 0);
    const dates = [...new Set(results.map(r => r.date.toDateString()))].sort();
    let streak = 0;
    if (dates.length) { streak = 1; for (let i = dates.length-1; i>0; i--) { if ((new Date(dates[i])-new Date(dates[i-1]))/86400000===1) streak++; else break; } }
    res.json({ totalPoints, quizCompleted: results.length, streak });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.get('/api/stats/profile', auth, async (req, res) => {
  try {
    const results = await QuizResult.find({ userId: req.user._id }).sort({ date: 1 });
    const totalPoints = results.reduce((s, r) => s + (r.points||0), 0);
    const maxScore = results.length ? Math.max(...results.map(r => Math.round((r.score/r.total)*100))) : 0;
    const byMatiere = {};
    results.forEach(r => { if(!byMatiere[r.matiere]) byMatiere[r.matiere]=0; byMatiere[r.matiere]+=(r.points||0); });
    const matiereRanking = Object.entries(byMatiere).sort((a,b)=>b[1]-a[1]).map(([name,pts])=>({name,pts}));
    const evolution = results.slice(-7).map(r=>({date:r.date,points:r.points}));
    let progress = 0;
    if (results.length>=2) { const h=Math.floor(results.length/2); const rec=results.slice(h).reduce((s,r)=>s+(r.points||0),0); const old=results.slice(0,h).reduce((s,r)=>s+(r.points||0),0); progress=old>0?Math.round(((rec-old)/old)*100):100; }
    res.json({ totalPoints, quizCompleted: results.length, maxScore, matiereRanking, evolution, progress });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// ── QUIZ ──
app.post('/api/quiz/submit', auth, async (req, res) => {
  try {
    const { score, total, matiere, lecon, annee, filiere, points } = req.body;
    const result = await QuizResult.create({ userId: req.user._id, score, total, matiere, lecon, annee, filiere, points: points||score*10 });
    res.status(201).json({ message: 'Score enregistré', result });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// ── IA PROXY ──
const callClaude = async (system, userMsg, maxTokens = 2000) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-opus-4-6', max_tokens:maxTokens, system, messages:[{role:'user',content:userMsg}] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Erreur API Claude');
  return data.content?.map(c=>c.text||'').join('') || '';
};

// IA Chat — réponse pédagogique selon le programme algérien
app.post('/api/ia/chat', auth, async (req, res) => {
  try {
    const { messages, annee, filiere, matiere } = req.body;
    const ctx = [annee&&`Année: ${annee}`, filiere&&`Filière: ${filiere}`, matiere&&`Matière: ${matiere}`].filter(Boolean).join(' | ');
    const system = `Tu es un professeur expert du programme scolaire algérien officiel (المنهاج الجزائري الرسمي).
${ctx ? 'Contexte élève: ' + ctx : ''}
RÈGLES:
1. Réponds selon la méthodologie pédagogique algérienne officielle
2. Si matière = Arabe ou Éducation Islamique → réponds en arabe, sinon en français
3. Structure: définition → explication → exemple algérien → règle
4. Utilise des exemples du contexte algérien (noms algériens, villes algériennes)
5. Pour math/physique: résous étape par étape avec la méthode algérienne
6. Sois encourageant comme un bon professeur algérien`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ message: 'Clé API manquante' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-opus-4-6', max_tokens:1500, system, messages })
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ message: data.error?.message || 'Erreur Claude' });
    const reply = data.content?.map(c=>c.text||'').join('') || '';
    res.json({ reply });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Génération de quiz + exercices math/physique
app.post('/api/ia/quiz', auth, async (req, res) => {
  try {
    const { annee, filiere, matiere, lecon, difficulte } = req.body;
    const isMathPhys = ['Mathématiques','Physique-Chimie','Sciences Techniques'].includes(matiere);
    const ctx = `Année: ${annee}${filiere?' - Filière: '+filiere:''} | Matière: ${matiere} | Leçon: ${lecon} | Difficulté: ${difficulte}`;

    const system = `Tu es un professeur expert du programme scolaire algérien. Réponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ou après.`;

    let prompt;
    if (isMathPhys) {
      prompt = `Génère 4 problèmes/exercices pour: ${ctx}

Types d'exercices selon le programme algérien:
- Mathématiques: calcul, démonstration, problème appliqué, géométrie selon le niveau
- Physique-Chimie: loi, calcul numérique, expérience, raisonnement

Format JSON exact (rien d'autre):
{"exercices":[{"numero":1,"titre":"Titre de l'exercice","enonce":"Énoncé complet et clair","donnees":"Données numériques si applicable","questions":["1) Question 1","2) Question 2","3) Question 3"],"correction":"Correction complète étape par étape avec justifications selon méthode algérienne","bareme":5}]}`;
    } else {
      const isArabe = ['Arabe','Éducation Islamique','Littérature Arabe'].includes(matiere);
      prompt = `Génère 8 questions QCM pour: ${ctx}
${isArabe ? 'Questions en arabe obligatoirement.' : 'Questions en français.'}
Selon le programme officiel algérien.

Format JSON exact (rien d'autre):
{"questions":[{"question":"Texte de la question ?","options":["A) Option A","B) Option B","C) Option C","D) Option D"],"correct":0,"explication":"Explication selon la méthodologie algérienne"}]}

correct = index 0,1,2 ou 3 de la bonne réponse.`;
    }

    const text = await callClaude(system, prompt, 2500);
    const clean = text.replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(clean);
    res.json({ ...parsed, isMathPhys });
  } catch (err) { res.status(500).json({ message: 'Erreur génération: ' + err.message }); }
});

// ── AMIS ──

// Rechercher un utilisateur
app.get('/api/users/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);
    const myFriends = req.user.friends.map(f => f.toString());
    const users = await User.find({
      _id: { $ne: req.user._id },
      $or: [
        { firstName: { $regex: q.trim(), $options: 'i' } },
        { lastName: { $regex: q.trim(), $options: 'i' } },
      ]
    }).select('firstName lastName').limit(8);

    // Enrichir avec le statut de la relation
    const enriched = await Promise.all(users.map(async u => {
      const isFriend = myFriends.includes(u._id.toString());
      const pendingReq = await FriendRequest.findOne({ from: req.user._id, to: u._id, status: 'pending' });
      return { id: u._id, firstName: u.firstName, lastName: u.lastName, isFriend, requestSent: !!pendingReq };
    }));
    res.json(enriched);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// Envoyer une demande d'ami
app.post('/api/friends/request', auth, async (req, res) => {
  try {
    const { toUserId } = req.body;
    if (toUserId === req.user._id.toString())
      return res.status(400).json({ message: 'Tu ne peux pas t\'ajouter toi-même' });
    const target = await User.findById(toUserId);
    if (!target) return res.status(404).json({ message: 'Utilisateur introuvable' });
    if (req.user.friends.map(f=>f.toString()).includes(toUserId))
      return res.status(400).json({ message: 'Vous êtes déjà amis' });
    const existing = await FriendRequest.findOne({ from: req.user._id, to: toUserId, status: 'pending' });
    if (existing) return res.status(400).json({ message: 'Demande déjà envoyée' });
    await FriendRequest.create({ from: req.user._id, to: toUserId });
    res.json({ message: `Demande envoyée à ${target.firstName} ${target.lastName} !` });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// Voir les demandes reçues
app.get('/api/friends/requests', auth, async (req, res) => {
  try {
    const requests = await FriendRequest.find({ to: req.user._id, status: 'pending' })
      .populate('from', 'firstName lastName');
    res.json(requests);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// Accepter une demande
app.post('/api/friends/accept', auth, async (req, res) => {
  try {
    const { requestId } = req.body;
    const request = await FriendRequest.findById(requestId);
    if (!request || request.to.toString() !== req.user._id.toString())
      return res.status(403).json({ message: 'Demande introuvable' });
    request.status = 'accepted';
    await request.save();
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { friends: request.from } });
    await User.findByIdAndUpdate(request.from, { $addToSet: { friends: req.user._id } });
    res.json({ message: 'Ami ajouté !' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// Refuser une demande
app.post('/api/friends/decline', auth, async (req, res) => {
  try {
    const { requestId } = req.body;
    const request = await FriendRequest.findById(requestId);
    if (!request || request.to.toString() !== req.user._id.toString())
      return res.status(403).json({ message: 'Demande introuvable' });
    request.status = 'declined';
    await request.save();
    res.json({ message: 'Demande refusée' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// Liste des amis avec stats
app.get('/api/friends', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('friends', 'firstName lastName compareVisible');
    const friendsWithStats = await Promise.all(user.friends.map(async f => {
      const results = await QuizResult.find({ userId: f._id });
      const totalPoints = results.reduce((s,r)=>s+(r.points||0), 0);
      const byMatiere = {};
      results.forEach(r => { if(!byMatiere[r.matiere]) byMatiere[r.matiere]=0; byMatiere[r.matiere]+=(r.points||0); });
      return { id: f._id, firstName: f.firstName, lastName: f.lastName, name: `${f.firstName} ${f.lastName}`, totalPoints, byMatiere, compareVisible: f.compareVisible };
    }));
    res.json(friendsWithStats);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// Supprimer un ami
app.delete('/api/friends/:friendId', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $pull: { friends: req.params.friendId } });
    await User.findByIdAndUpdate(req.params.friendId, { $pull: { friends: req.user._id } });
    res.json({ message: 'Ami supprimé' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// Toggle visibilité
app.patch('/api/friends/visibility', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { compareVisible: req.body.visible });
    res.json({ message: 'Visibilité mise à jour' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// ── HEALTH ──
app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'EDUMIND IA Backend Running 🧠' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 EDUMIND Backend running on port ${PORT}`));
