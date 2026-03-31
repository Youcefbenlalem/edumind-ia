require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/edumind')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

const userSchema = new mongoose.Schema({
  firstName:      { type: String, required: true },
  lastName:       { type: String, required: true },
  email:          { type: String, required: true, unique: true, lowercase: true },
  password:       { type: String, required: true },
  friends:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  compareVisible: { type: Boolean, default: true },
  createdAt:      { type: Date, default: Date.now }
});

const friendRequestSchema = new mongoose.Schema({
  from:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:    { type: String, enum: ['pending','accepted','declined'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const quizResultSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  annee:   String, filiere: String, matiere: String, lecon: String,
  score:   Number, total:   Number,
  points:  { type: Number, default: 0 },
  date:    { type: Date, default: Date.now }
});

const User       = mongoose.model('User', userSchema);
const FriendReq  = mongoose.model('FriendRequest', friendRequestSchema);
const QuizResult = mongoose.model('QuizResult', quizResultSchema);

const JWT_SECRET = process.env.JWT_SECRET || 'edumind_secret_key';
const makeToken  = id => jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' });

const auth = async (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Non authentifié' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return res.status(401).json({ message: 'Utilisateur introuvable' });
    next();
  } catch { res.status(401).json({ message: 'Token invalide' }); }
};

const callGemini = async (prompt, maxTokens) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY manquante sur Render');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens || 2500 }
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Erreur Gemini');
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
};

const extractJSON = (text) => {
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); } catch {}
  try { const m = text.match(/(\{[\s\S]*\})/); if (m) return JSON.parse(m[0]); } catch {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a !== -1 && b !== -1) return JSON.parse(text.substring(a, b + 1));
  throw new Error('JSON introuvable dans la réponse Gemini');
};

app.post('/api/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    if (!firstName || !lastName || !email || !password)
      return res.status(400).json({ message: 'Tous les champs sont obligatoires' });
    if (await User.findOne({ email }))
      return res.status(400).json({ message: 'Email déjà utilisé' });
    const hashed = await bcrypt.hash(password, 12);
    const user   = await User.create({ firstName, lastName, email, password: hashed });
    res.status(201).json({ token: makeToken(user._id), user: { id: user._id, firstName, lastName, email } });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(400).json({ message: 'Email ou mot de passe incorrect' });
    res.json({ token: makeToken(user._id), user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email } });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/stats', auth, async (req, res) => {
  try {
    const results     = await QuizResult.find({ userId: req.user._id });
    const totalPoints = results.reduce((s, r) => s + (r.points || 0), 0);
    const dates       = [...new Set(results.map(r => r.date.toDateString()))].sort();
    let streak = 0;
    if (dates.length) { streak = 1; for (let i = dates.length - 1; i > 0; i--) { if ((new Date(dates[i]) - new Date(dates[i-1])) / 86400000 === 1) streak++; else break; } }
    res.json({ totalPoints, quizCompleted: results.length, streak });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/stats/profile', auth, async (req, res) => {
  try {
    const results     = await QuizResult.find({ userId: req.user._id }).sort({ date: 1 });
    const totalPoints = results.reduce((s, r) => s + (r.points || 0), 0);
    const maxScore    = results.length ? Math.max(...results.map(r => Math.round((r.score / r.total) * 100))) : 0;
    const byMatiere   = {};
    results.forEach(r => { byMatiere[r.matiere] = (byMatiere[r.matiere] || 0) + (r.points || 0); });
    const matiereRanking = Object.entries(byMatiere).sort((a, b) => b[1] - a[1]).map(([name, pts]) => ({ name, pts }));
    const evolution      = results.slice(-7).map(r => ({ date: r.date, points: r.points }));
    let progress = 0;
    if (results.length >= 2) { const h = Math.floor(results.length / 2); const rec = results.slice(h).reduce((s, r) => s + (r.points || 0), 0); const old = results.slice(0, h).reduce((s, r) => s + (r.points || 0), 0); progress = old > 0 ? Math.round(((rec - old) / old) * 100) : 100; }
    res.json({ totalPoints, quizCompleted: results.length, maxScore, matiereRanking, evolution, progress });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/quiz/submit', auth, async (req, res) => {
  try {
    const { score, total, matiere, lecon, annee, filiere, points } = req.body;
    const result = await QuizResult.create({ userId: req.user._id, score, total, matiere, lecon, annee, filiere, points: points || score * 10 });
    res.status(201).json({ message: 'Score enregistré', result });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/ia/chat', auth, async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ message: 'GEMINI_API_KEY manquante sur Render' });
    const { messages, annee, filiere, matiere } = req.body;
    const ctx = [annee && `Année: ${annee}`, filiere && `Filière: ${filiere}`, matiere && `Matière: ${matiere}`].filter(Boolean).join(' | ');
    const system = `Tu es un professeur expert du programme scolaire algérien officiel.\n${ctx ? 'Contexte élève: ' + ctx : ''}\nRÈGLES: Réponds selon la méthodologie algérienne. Si Arabe/Éducation Islamique → réponds en arabe, sinon en français. Structure: définition → explication → exemple algérien → règle. Sois encourageant.`;
    const lastMsg = (messages || []).slice(-1)[0]?.content || '';
    const reply = await callGemini(system + '\n\nQuestion de l\'élève: ' + lastMsg, 1500);
    res.json({ reply });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/ia/quiz', auth, async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ message: 'GEMINI_API_KEY manquante sur Render' });
    const { annee, filiere, matiere, lecon, difficulte } = req.body;
    const isMathPhys = ['Mathématiques', 'Physique-Chimie', 'Sciences Techniques'].includes(matiere);
    const ctx = `Année: ${annee}${filiere ? ' - Filière: ' + filiere : ''} | Matière: ${matiere} | Leçon: ${lecon} | Difficulté: ${difficulte}`;

    let prompt;
    if (isMathPhys) {
      prompt = `Tu es un professeur du programme scolaire algérien. Génère 4 exercices pour: ${ctx}
Réponds avec UNIQUEMENT ce JSON brut (rien d'autre, commence par {):
{"exercices":[{"numero":1,"titre":"Titre","enonce":"Énoncé complet","donnees":"Données","questions":["1) Q1","2) Q2"],"correction":"Correction étape par étape","bareme":5},{"numero":2,"titre":"...","enonce":"...","donnees":"...","questions":["1) ..."],"correction":"...","bareme":5},{"numero":3,"titre":"...","enonce":"...","donnees":"...","questions":["1) ..."],"correction":"...","bareme":5},{"numero":4,"titre":"...","enonce":"...","donnees":"...","questions":["1) ..."],"correction":"...","bareme":5}]}`;
    } else {
      const arabe = ['Arabe', 'Éducation Islamique', 'Littérature Arabe'].includes(matiere);
      prompt = `Tu es un professeur du programme scolaire algérien. Génère 8 questions QCM pour: ${ctx}
${arabe ? 'Questions en arabe.' : 'Questions en français.'}
Réponds avec UNIQUEMENT ce JSON brut (commence directement par {, pas de texte avant):
{"questions":[{"question":"Q1?","options":["A) ...","B) ...","C) ...","D) ..."],"correct":0,"explication":"..."},{"question":"Q2?","options":["A) ...","B) ...","C) ...","D) ..."],"correct":1,"explication":"..."},{"question":"Q3?","options":["A) ...","B) ...","C) ...","D) ..."],"correct":2,"explication":"..."},{"question":"Q4?","options":["A) ...","B) ...","C) ...","D) ..."],"correct":0,"explication":"..."},{"question":"Q5?","options":["A) ...","B) ...","C) ...","D) ..."],"correct":3,"explication":"..."},{"question":"Q6?","options":["A) ...","B) ...","C) ...","D) ..."],"correct":1,"explication":"..."},{"question":"Q7?","options":["A) ...","B) ...","C) ...","D) ..."],"correct":2,"explication":"..."},{"question":"Q8?","options":["A) ...","B) ...","C) ...","D) ..."],"correct":0,"explication":"..."}]}`;
    }

    const text   = await callGemini(prompt, 3000);
    const parsed = extractJSON(text);
    res.json({ ...parsed, isMathPhys });
  } catch (e) { res.status(500).json({ message: 'Erreur génération: ' + e.message }); }
});

app.get('/api/users/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const myFriends = req.user.friends.map(f => f.toString());
    const users = await User.find({ _id: { $ne: req.user._id }, $or: [{ firstName: { $regex: q, $options: 'i' } }, { lastName: { $regex: q, $options: 'i' } }] }).select('firstName lastName').limit(8);
    const enriched = await Promise.all(users.map(async u => {
      const isFriend   = myFriends.includes(u._id.toString());
      const pendingReq = await FriendReq.findOne({ from: req.user._id, to: u._id, status: 'pending' });
      return { id: u._id, firstName: u.firstName, lastName: u.lastName, isFriend, requestSent: !!pendingReq };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/friends/request', auth, async (req, res) => {
  try {
    const { toUserId } = req.body;
    if (toUserId === req.user._id.toString()) return res.status(400).json({ message: 'Tu ne peux pas t\'ajouter toi-même' });
    const target = await User.findById(toUserId);
    if (!target) return res.status(404).json({ message: 'Utilisateur introuvable' });
    if (req.user.friends.map(f => f.toString()).includes(toUserId)) return res.status(400).json({ message: 'Déjà amis' });
    const existing = await FriendReq.findOne({ from: req.user._id, to: toUserId, status: 'pending' });
    if (existing) return res.status(400).json({ message: 'Demande déjà envoyée' });
    await FriendReq.create({ from: req.user._id, to: toUserId });
    res.json({ message: `Demande envoyée à ${target.firstName} ${target.lastName} !` });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/friends/requests', auth, async (req, res) => {
  try {
    const requests = await FriendReq.find({ to: req.user._id, status: 'pending' }).populate('from', 'firstName lastName');
    res.json(requests);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/friends/accept', auth, async (req, res) => {
  try {
    const request = await FriendReq.findById(req.body.requestId);
    if (!request || request.to.toString() !== req.user._id.toString()) return res.status(403).json({ message: 'Demande introuvable' });
    request.status = 'accepted'; await request.save();
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { friends: request.from } });
    await User.findByIdAndUpdate(request.from, { $addToSet: { friends: req.user._id } });
    res.json({ message: 'Ami ajouté !' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/friends/decline', auth, async (req, res) => {
  try {
    const request = await FriendReq.findById(req.body.requestId);
    if (!request || request.to.toString() !== req.user._id.toString()) return res.status(403).json({ message: 'Demande introuvable' });
    request.status = 'declined'; await request.save();
    res.json({ message: 'Demande refusée' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/friends', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('friends', 'firstName lastName compareVisible');
    const list = await Promise.all(user.friends.map(async f => {
      const results     = await QuizResult.find({ userId: f._id });
      const totalPoints = results.reduce((s, r) => s + (r.points || 0), 0);
      const byMatiere   = {};
      results.forEach(r => { byMatiere[r.matiere] = (byMatiere[r.matiere] || 0) + (r.points || 0); });
      return { id: f._id, firstName: f.firstName, lastName: f.lastName, name: `${f.firstName} ${f.lastName}`, totalPoints, byMatiere, compareVisible: f.compareVisible };
    }));
    res.json(list);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete('/api/friends/:friendId', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $pull: { friends: req.params.friendId } });
    await User.findByIdAndUpdate(req.params.friendId, { $pull: { friends: req.user._id } });
    res.json({ message: 'Ami supprimé' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.patch('/api/friends/visibility', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { compareVisible: req.body.visible });
    res.json({ message: 'Visibilité mise à jour' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', message: 'EDUMIND IA Backend Running 🧠' }));

app.listen(process.env.PORT || 5000, () => {
  console.log(`🚀 EDUMIND Backend running on port ${process.env.PORT || 5000}`);
});

