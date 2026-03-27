const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── MONGOOSE CONNECTION ──
mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/edumind')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ──────────────────────────────────────────────
// MODELS
// ──────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  firstName:  { type: String, required: true },
  lastName:   { type: String, required: true },
  email:      { type: String, required: true, unique: true, lowercase: true },
  password:   { type: String, required: true },
  friends:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  compareVisible: { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now },
});
const User = mongoose.model('User', UserSchema);

const QuizResultSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  annee:    String,
  filiere:  String,
  matiere:  String,
  lecon:    String,
  score:    Number,
  total:    Number,
  points:   { type: Number, default: 0 },
  date:     { type: Date, default: Date.now },
});
const QuizResult = mongoose.model('QuizResult', QuizResultSchema);

// ──────────────────────────────────────────────
// MIDDLEWARE
// ──────────────────────────────────────────────
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Non authentifié' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'edumind_secret_key');
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return res.status(401).json({ message: 'Utilisateur introuvable' });
    next();
  } catch {
    res.status(401).json({ message: 'Token invalide' });
  }
};

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'edumind_secret_key', { expiresIn: '30d' });

// ──────────────────────────────────────────────
// AUTH ROUTES
// ──────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    if (!firstName || !lastName || !email || !password)
      return res.status(400).json({ message: 'Tous les champs sont obligatoires' });
    if (await User.findOne({ email }))
      return res.status(400).json({ message: 'Cet email est déjà utilisé' });
    const hashedPwd = await bcrypt.hash(password, 12);
    const user = await User.create({ firstName, lastName, email, password: hashedPwd });
    const token = signToken(user._id);
    res.status(201).json({ token, user: { id: user._id, firstName, lastName, email } });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(400).json({ message: 'Email ou mot de passe incorrect' });
    const token = signToken(user._id);
    res.json({ token, user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email } });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ──────────────────────────────────────────────
// STATS ROUTES
// ──────────────────────────────────────────────
app.get('/api/stats', auth, async (req, res) => {
  try {
    const results = await QuizResult.find({ userId: req.user._id });
    const totalPoints = results.reduce((s, r) => s + (r.points || 0), 0);
    const quizCompleted = results.length;
    // Streak: consecutive days with at least 1 quiz
    const dates = [...new Set(results.map(r => r.date.toDateString()))].sort();
    let streak = 0;
    if (dates.length) {
      streak = 1;
      for (let i = dates.length - 1; i > 0; i--) {
        const diff = (new Date(dates[i]) - new Date(dates[i-1])) / 86400000;
        if (diff === 1) streak++; else break;
      }
    }
    res.json({ totalPoints, quizCompleted, streak });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.get('/api/stats/profile', auth, async (req, res) => {
  try {
    const results = await QuizResult.find({ userId: req.user._id }).sort({ date: 1 });
    const totalPoints = results.reduce((s, r) => s + (r.points || 0), 0);
    const quizCompleted = results.length;
    const maxScore = results.length ? Math.max(...results.map(r => Math.round((r.score/r.total)*100))) : 0;

    // Matiere ranking
    const byMatiere = {};
    results.forEach(r => {
      if (!byMatiere[r.matiere]) byMatiere[r.matiere] = 0;
      byMatiere[r.matiere] += r.points || 0;
    });
    const matiereRanking = Object.entries(byMatiere).sort((a,b) => b[1]-a[1]).map(([name,pts]) => ({ name, pts }));

    // Evolution (last 7 data points)
    const evolution = results.slice(-7).map(r => ({ date: r.date, points: r.points }));

    // Progress: compare last 7 vs previous 7
    let progress = 0;
    if (results.length >= 2) {
      const half = Math.floor(results.length / 2);
      const recent = results.slice(half).reduce((s,r) => s + (r.points||0), 0);
      const old    = results.slice(0, half).reduce((s,r) => s + (r.points||0), 0);
      progress = old > 0 ? Math.round(((recent - old) / old) * 100) : 100;
    }

    res.json({ totalPoints, quizCompleted, maxScore, matiereRanking, evolution, progress });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ──────────────────────────────────────────────
// QUIZ ROUTES
// ──────────────────────────────────────────────
app.post('/api/quiz/submit', auth, async (req, res) => {
  try {
    const { score, total, matiere, lecon, annee, filiere, points } = req.body;
    const result = await QuizResult.create({
      userId: req.user._id, score, total, matiere, lecon, annee, filiere,
      points: points || score * 10
    });
    res.status(201).json({ message: 'Score enregistré', result });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.get('/api/quiz/history', auth, async (req, res) => {
  try {
    const results = await QuizResult.find({ userId: req.user._id }).sort({ date: -1 }).limit(20);
    res.json(results);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ──────────────────────────────────────────────
// FRIENDS ROUTES
// ──────────────────────────────────────────────
app.post('/api/friends/add', auth, async (req, res) => {
  try {
    const { email } = req.body;
    const friend = await User.findOne({ email });
    if (!friend) return res.status(404).json({ message: 'Utilisateur introuvable' });
    if (friend._id.toString() === req.user._id.toString())
      return res.status(400).json({ message: 'Tu ne peux pas t\'ajouter toi-même' });
    if (req.user.friends.includes(friend._id))
      return res.status(400).json({ message: 'Déjà dans tes amis' });
    await User.findByIdAndUpdate(req.user._id, { $push: { friends: friend._id } });
    res.json({ message: 'Ami ajouté !', friend: { id: friend._id, firstName: friend.firstName, lastName: friend.lastName } });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.get('/api/friends', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('friends', 'firstName lastName email compareVisible');
    const friendsWithStats = await Promise.all(
      user.friends.filter(f => f.compareVisible).map(async f => {
        const results = await QuizResult.find({ userId: f._id });
        const totalPoints = results.reduce((s, r) => s + (r.points || 0), 0);
        const byMatiere = {};
        results.forEach(r => {
          if (!byMatiere[r.matiere]) byMatiere[r.matiere] = 0;
          byMatiere[r.matiere] += r.points || 0;
        });
        return { id: f._id, name: `${f.firstName} ${f.lastName}`, totalPoints, byMatiere };
      })
    );
    res.json(friendsWithStats);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.patch('/api/friends/visibility', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { compareVisible: req.body.visible });
    res.json({ message: 'Visibilité mise à jour' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ──────────────────────────────────────────────
// HEALTH
// ──────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'EDUMIND IA Backend Running 🧠' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 EDUMIND Backend running on port ${PORT}`));