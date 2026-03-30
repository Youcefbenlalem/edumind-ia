const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Initialisation Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  matiere:   { type: String, required: true },
  lecon:     { type: String },
  score:     { type: Number, required: true },
  total:     { type: Number, required: true },
  points:    { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});
const QuizResult = mongoose.model('QuizResult', QuizResultSchema);

// ── AUTH MIDDLEWARE ──
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Non autorisé' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.user = decoded;
    next();
  } catch (err) { res.status(401).json({ message: 'Token invalide' }); }
};

// ── ROUTES AUTH ──
app.post('/api/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'Cet email existe déjà' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ firstName, lastName, email, password: hashedPassword });
    await user.save();
    const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET || 'secret');
    res.json({ token, user: { firstName, lastName, email } });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Utilisateur non trouvé' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Mot de passe incorrect' });
    const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET || 'secret');
    res.json({ token, user: { firstName: user.firstName, lastName: user.lastName, email: user.email } });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json(user);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// ── ROUTES FRIENDS & STATS ──
app.get('/api/friends/search', auth, async (req, res) => {
  try {
    const q = req.query.q;
    if(!q) return res.json([]);
    const users = await User.find({
      $or: [{ firstName: new RegExp(q, 'i') }, { lastName: new RegExp(q, 'i') }],
      _id: { $ne: req.user._id }
    }).limit(10).select('firstName lastName');
    res.json(users);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.post('/api/friends/request', auth, async (req, res) => {
  try {
    const { to } = req.body;
    const exists = await FriendRequest.findOne({ from: req.user._id, to, status: 'pending' });
    if (exists) return res.status(400).json({ message: 'Demande déjà envoyée' });
    const reqDoc = new FriendRequest({ from: req.user._id, to });
    await reqDoc.save();
    res.json({ message: 'Demande envoyée' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.get('/api/friends/requests', auth, async (req, res) => {
  try {
    const requests = await FriendRequest.find({ to: req.user._id, status: 'pending' }).populate('from', 'firstName lastName');
    res.json(requests);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.post('/api/friends/respond', auth, async (req, res) => {
  try {
    const { requestId, accept } = req.body;
    const freq = await FriendRequest.findById(requestId);
    if (!freq) return res.status(404).json({ message: 'Demande introuvable' });
    if (accept) {
      freq.status = 'accepted';
      await User.findByIdAndUpdate(freq.from, { $addToSet: { friends: freq.to } });
      await User.findByIdAndUpdate(freq.to, { $addToSet: { friends: freq.from } });
    } else {
      freq.status = 'declined';
    }
    await freq.save();
    res.json({ message: accept ? 'Acceptée' : 'Refusée' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.get('/api/friends/list', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('friends', 'firstName lastName compareVisible');
    const friendsWithStats = await Promise.all(user.friends.map(async (f) => {
      const results = await QuizResult.find({ userId: f._id });
      const totalPoints = results.reduce((s,r)=>s+(r.points||0), 0);
      const byMatiere = {};
      results.forEach(r => { if(!byMatiere[r.matiere]) byMatiere[r.matiere]=0; byMatiere[r.matiere]+=(r.points||0); });
      return { id: f._id, firstName: f.firstName, lastName: f.lastName, name: `${f.firstName} ${f.lastName}`, totalPoints, byMatiere, compareVisible: f.compareVisible };
    }));
    res.json(friendsWithStats);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.delete('/api/friends/:friendId', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $pull: { friends: req.params.friendId } });
    await User.findByIdAndUpdate(req.params.friendId, { $pull: { friends: req.user._id } });
    res.json({ message: 'Ami supprimé' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.patch('/api/friends/visibility', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { compareVisible: req.body.visible });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.post('/api/quiz/submit', auth, async (req, res) => {
  try {
    const result = new QuizResult({ ...req.body, userId: req.user._id });
    await result.save();
    res.json({ message: 'Score enregistré' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

app.get('/api/stats/me', auth, async (req, res) => {
  try {
    const results = await QuizResult.find({ userId: req.user._id });
    const totalPoints = results.reduce((s,r)=>s+(r.points||0), 0);
    const byMatiere = {};
    results.forEach(r => { if(!byMatiere[r.matiere]) byMatiere[r.matiere]=0; byMatiere[r.matiere]+=(r.points||0); });
    res.json({ totalPoints, byMatiere, count: results.length });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur' }); }
});

// ── IA PROXY GEMINI ──
const callGemini = async (system, userMsg) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY manquante sur Render');

  const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    systemInstruction: system 
  });

  const result = await model.generateContent(userMsg);
  const response = await result.response;
  return response.text();
};

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

    const userMsg = messages[messages.length - 1].content;
    const reply = await callGemini(system, userMsg);
    res.json({ reply });
  } catch (err) { 
    res.status(500).json({ message: "Erreur de l'IA (Vérifie ta clé GEMINI sur Render)" }); 
  }
});

app.post('/api/ia/quiz', auth, async (req, res) => {
  try {
    const { annee, filiere, matiere, lecon, diff } = req.body;
    const system = `Tu es un concepteur de quiz pour le programme scolaire algérien. 
Tu dois générer un JSON pur (sans texte avant ou après) contenant 5 questions de type QCM.
Format: { "questions": [ { "q": "...", "options": ["...", "..."], "correct": 0, "explication": "..." } ] }`;

    const prompt = `Génère un quiz de niveau ${annee} ${filiere||''} sur la matière ${matiere}, leçon: ${lecon}. Difficulté: ${diff}/5.`;
    
    const raw = await callGemini(system, prompt);
    const cleanJson = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    res.json(JSON.parse(cleanJson));
  } catch (err) { 
    res.status(500).json({ message: "Erreur lors de la génération du quiz" }); 
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
