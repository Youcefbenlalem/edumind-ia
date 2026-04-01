require(‘dotenv’).config();
const express  = require(‘express’);
const mongoose = require(‘mongoose’);
const cors     = require(‘cors’);
const jwt      = require(‘jsonwebtoken’);
const bcrypt   = require(‘bcryptjs’);

const app = express();
app.use(cors({ origin: ‘*’ }));
app.use(express.json());

mongoose.connect(process.env.MONGO_URL || ‘mongodb://localhost:27017/edumind’)
.then(() => console.log(‘MongoDB connected’))
.catch(err => console.error(‘MongoDB error:’, err));

// – MODELS –
const userSchema = new mongoose.Schema({
firstName:      { type: String, required: true },
lastName:       { type: String, required: true },
email:          { type: String, required: true, unique: true, lowercase: true },
password:       { type: String, required: true },
friends:        [{ type: mongoose.Schema.Types.ObjectId, ref: ‘User’ }],
compareVisible: { type: Boolean, default: true },
createdAt:      { type: Date, default: Date.now }
});

const friendRequestSchema = new mongoose.Schema({
from:      { type: mongoose.Schema.Types.ObjectId, ref: ‘User’, required: true },
to:        { type: mongoose.Schema.Types.ObjectId, ref: ‘User’, required: true },
status:    { type: String, enum: [‘pending’,‘accepted’,‘declined’], default: ‘pending’ },
createdAt: { type: Date, default: Date.now }
});

const quizResultSchema = new mongoose.Schema({
userId:  { type: mongoose.Schema.Types.ObjectId, ref: ‘User’, required: true },
annee:   String, filiere: String, matiere: String, lecon: String,
score:   Number, total: Number,
points:  { type: Number, default: 0 },
isMath:  { type: Boolean, default: false },
date:    { type: Date, default: Date.now }
});

const User       = mongoose.model(‘User’, userSchema);
const FriendReq  = mongoose.model(‘FriendRequest’, friendRequestSchema);
const QuizResult = mongoose.model(‘QuizResult’, quizResultSchema);

// – AUTH –
const JWT_SECRET = process.env.JWT_SECRET || ‘edumind_secret_key’;
const makeToken  = id => jwt.sign({ id }, JWT_SECRET, { expiresIn: ‘30d’ });

const auth = async (req, res, next) => {
const token = (req.headers.authorization || ‘’).replace(‘Bearer ‘, ‘’);
if (!token) return res.status(401).json({ message: ‘Non authentifie’ });
try {
const decoded = jwt.verify(token, JWT_SECRET);
req.user = await User.findById(decoded.id).select(’-password’);
if (!req.user) return res.status(401).json({ message: ‘Utilisateur introuvable’ });
next();
} catch { res.status(401).json({ message: ‘Token invalide’ }); }
};

// – GROQ –
const GROQ_MODEL = ‘llama-3.3-70b-versatile’;
const GROQ_URL   = ‘https://api.groq.com/openai/v1/chat/completions’;

const callGroq = async (systemPrompt, userPrompt, jsonMode = false) => {
const key = process.env.GROQ_API_KEY;
if (!key) throw new Error(‘GROQ_API_KEY manquante sur Render’);

const body = {
model: GROQ_MODEL,
temperature: 0.5,
max_tokens: 3000,
messages: [
{ role: ‘system’, content: systemPrompt },
{ role: ‘user’,   content: userPrompt   }
]
};
if (jsonMode) body.response_format = { type: ‘json_object’ };

const r = await fetch(GROQ_URL, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’, ‘Authorization’: ’Bearer ’ + key },
body: JSON.stringify(body)
});

const d = await r.json();
if (!r.ok) throw new Error(d.error?.message || ’Erreur Groq ’ + r.status);
const text = d.choices?.[0]?.message?.content || ‘’;
if (!text) throw new Error(‘Groq a retourne une reponse vide’);
return text;
};

const extractJSON = (text) => {
const clean = text.replace(/`json/g, '').replace(/`/g, ‘’).trim();
const a = clean.indexOf(’{’);
const b = clean.lastIndexOf(’}’);
if (a === -1 || b === -1) throw new Error(‘Aucun JSON dans la reponse’);
try { return JSON.parse(clean.substring(a, b + 1)); }
catch (e) { throw new Error(’JSON invalide: ’ + e.message); }
};

// – AUTH ROUTES –
app.post(’/api/auth/register’, async (req, res) => {
try {
const { firstName, lastName, email, password } = req.body;
if (!firstName || !lastName || !email || !password)
return res.status(400).json({ message: ‘Tous les champs sont obligatoires’ });
if (await User.findOne({ email }))
return res.status(400).json({ message: ‘Email deja utilise’ });
const hashed = await bcrypt.hash(password, 12);
const user   = await User.create({ firstName, lastName, email, password: hashed });
res.status(201).json({ token: makeToken(user._id), user: { id: user._id, firstName, lastName, email } });
} catch (e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/auth/login’, async (req, res) => {
try {
const { email, password } = req.body;
const user = await User.findOne({ email });
if (!user || !(await bcrypt.compare(password, user.password)))
return res.status(400).json({ message: ‘Email ou mot de passe incorrect’ });
res.json({ token: makeToken(user._id), user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email } });
} catch (e) { res.status(500).json({ message: e.message }); }
});

// – STATS DASHBOARD –
app.get(’/api/stats’, auth, async (req, res) => {
try {
const results     = await QuizResult.find({ userId: req.user._id });
const totalPoints = results.reduce((s, r) => s + (r.points || 0), 0);
const dates       = Array.from(new Set(results.map(r => r.date.toDateString()))).sort();
let streak = 0;
if (dates.length) {
streak = 1;
for (let i = dates.length - 1; i > 0; i–) {
if ((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000 === 1) streak++;
else break;
}
}
res.json({ totalPoints, quizCompleted: results.length, streak });
} catch (e) { res.status(500).json({ message: e.message }); }
});

// – STATS PROFILE COMPLET –
app.get(’/api/stats/profile’, auth, async (req, res) => {
try {
const results = await QuizResult.find({ userId: req.user._id }).sort({ date: 1 });

```
const totalPoints   = results.reduce((s, r) => s + (r.points || 0), 0);
const quizCompleted = results.length;

const prime = results.length
  ? Math.max.apply(null, results.map(r => r.total > 0 ? Math.round((r.score / r.total) * 100) : 0))
  : 0;

const byMatiere = {};
results.forEach(r => {
  if (r.matiere) byMatiere[r.matiere] = (byMatiere[r.matiere] || 0) + (r.points || 0);
});
const matiereRanking = Object.entries(byMatiere)
  .sort((a, b) => b[1] - a[1])
  .map(function(entry) { return { name: entry[0], pts: entry[1] }; });

const now = new Date();
const weeklyData = {};
for (let w = 7; w >= 0; w--) {
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - w * 7);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  const label = 'S' + (8 - w);
  weeklyData[label] = results
    .filter(r => new Date(r.date) >= weekStart && new Date(r.date) < weekEnd)
    .reduce((s, r) => s + (r.points || 0), 0);
}
const evolution = {
  labels: Object.keys(weeklyData),
  data:   Object.values(weeklyData)
};

const vals    = Object.values(weeklyData);
const thisWeek = vals[vals.length - 1] || 0;
const prevWeek = vals[vals.length - 2] || 0;
let progress = 0;
if (prevWeek > 0) progress = Math.round(((thisWeek - prevWeek) / prevWeek) * 100);
else if (thisWeek > 0) progress = 100;

res.json({ totalPoints, quizCompleted, prime, matiereRanking, evolution, progress });
```

} catch (e) { res.status(500).json({ message: e.message }); }
});

// – QUIZ SUBMIT –
app.post(’/api/quiz/submit’, auth, async (req, res) => {
try {
const { score, total, matiere, lecon, annee, filiere, points, isMath } = req.body;
await QuizResult.create({
userId: req.user._id, score, total, matiere, lecon, annee, filiere,
points: points || score * 10,
isMath: isMath || false
});
res.status(201).json({ message: ‘Score enregistre’ });
} catch (e) { res.status(500).json({ message: e.message }); }
});

// – IA CHAT –
app.post(’/api/ia/chat’, auth, async (req, res) => {
try {
if (!process.env.GROQ_API_KEY)
return res.status(500).json({ message: ‘GROQ_API_KEY manquante sur Render’ });
const { messages, annee, filiere, matiere } = req.body;
const ctxParts = [];
if (annee)   ctxParts.push(’Annee: ’ + annee);
if (filiere) ctxParts.push(’Filiere: ’ + filiere);
if (matiere) ctxParts.push(‘Matiere: ’ + matiere);
const ctx     = ctxParts.join(’ | ’);
const lastMsg = (messages || []).slice(-1)[0]?.content || ‘’;
const systemPrompt = ’Tu es un professeur expert du programme scolaire algerien officiel (ONEC). ’
+ (ctx ? ’Contexte eleve: ’ + ctx + ’. ’ : ‘’)
+ ’Regles: Reponds selon la methodologie algerienne. Si Arabe ou Education Islamique reponds en arabe, sinon en francais. ’
+ ‘Structure: definition, explication, exemple algerien concret, regle a retenir. Sois pedagogique et encourageant.’;
const reply = await callGroq(systemPrompt, lastMsg, false);
res.json({ reply });
} catch (e) { res.status(500).json({ message: e.message }); }
});

// – IA QUIZ –
app.post(’/api/ia/quiz’, auth, async (req, res) => {
try {
if (!process.env.GROQ_API_KEY)
return res.status(500).json({ message: ‘GROQ_API_KEY manquante sur Render’ });

```
const { annee, filiere, matiere, lecon, difficulte } = req.body;
const isMathPhys = ['Mathematiques','Mathematiques','Physique-Chimie','Sciences Techniques'].includes(matiere);
const ctx = annee + (filiere ? ' ' + filiere : '') + ' - ' + matiere + ' - ' + lecon + ' - niveau ' + difficulte;

const systemPrompt = 'Tu es un professeur expert du programme scolaire algerien officiel (ONEC). '
  + 'Tu generes des questions STRICTEMENT conformes au programme algerien. '
  + 'Tu reponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ou apres.';

let userPrompt;
if (isMathPhys) {
  userPrompt = 'Cree 4 exercices de ' + matiere + ' pour: ' + ctx + '. '
    + 'Ecris les maths en texte simple: / pour fractions, ^ pour puissances, racine() pour racines. PAS de LaTeX. '
    + 'Retourne ce JSON: { "exercices": ['
    + '{"numero": 1, "titre": "...", "enonce": "...", "donnees": "...", "questions": ["1) ..."], "correction": "...", "bareme": 5},'
    + '{"numero": 2, "titre": "...", "enonce": "...", "donnees": "...", "questions": ["1) ..."], "correction": "...", "bareme": 5},'
    + '{"numero": 3, "titre": "...", "enonce": "...", "donnees": "...", "questions": ["1) ..."], "correction": "...", "bareme": 5},'
    + '{"numero": 4, "titre": "...", "enonce": "...", "donnees": "...", "questions": ["1) ..."], "correction": "...", "bareme": 5}'
    + '] }';
} else {
  const arabe = ['Arabe','Education Islamique','Education Islamique','Litterature Arabe','Litterature Arabe'].includes(matiere);
  userPrompt = 'Cree 8 questions QCM sur: ' + ctx + '. '
    + (arabe ? 'Questions et reponses en arabe.' : 'Questions et reponses en francais.')
    + ' Retourne ce JSON: { "questions": ['
    + '{"question": "...", "options": ["A) ...","B) ...","C) ...","D) ..."], "correct": 0, "explication": "..."},'
    + '{"question": "...", "options": ["A) ...","B) ...","C) ...","D) ..."], "correct": 1, "explication": "..."},'
    + '{"question": "...", "options": ["A) ...","B) ...","C) ...","D) ..."], "correct": 2, "explication": "..."},'
    + '{"question": "...", "options": ["A) ...","B) ...","C) ...","D) ..."], "correct": 0, "explication": "..."},'
    + '{"question": "...", "options": ["A) ...","B) ...","C) ...","D) ..."], "correct": 3, "explication": "..."},'
    + '{"question": "...", "options": ["A) ...","B) ...","C) ...","D) ..."], "correct": 1, "explication": "..."},'
    + '{"question": "...", "options": ["A) ...","B) ...","C) ...","D) ..."], "correct": 2, "explication": "..."},'
    + '{"question": "...", "options": ["A) ...","B) ...","C) ...","D) ..."], "correct": 0, "explication": "..."}'
    + '] }';
}

const text   = await callGroq(systemPrompt, userPrompt, true);
const parsed = extractJSON(text);
if (!parsed.questions && !parsed.exercices)
  throw new Error('Structure JSON incorrecte');

const response = Object.assign({}, parsed, { isMathPhys: isMathPhys });
res.json(response);
```

} catch (e) { res.status(500).json({ message: ’Erreur generation: ’ + e.message }); }
});

// – IA EVALUATION EXERCICE MATH –
app.post(’/api/ia/evaluate’, auth, async (req, res) => {
try {
if (!process.env.GROQ_API_KEY)
return res.status(500).json({ message: ‘GROQ_API_KEY manquante’ });

```
const { enonce, donnees, questions, correction, studentAnswer, bareme, matiere, annee } = req.body;

const systemPrompt = 'Tu es un professeur correcteur expert du programme scolaire algerien officiel. '
  + 'Tu corriges les reponses des eleves avec bienveillance et precision. '
  + 'Tu reponds UNIQUEMENT en JSON valide.';

const userPrompt = 'Exercice de ' + matiere + ' (' + annee + '):\n'
  + 'Enonce: ' + enonce + '\n'
  + (donnees ? 'Donnees: ' + donnees + '\n' : '')
  + 'Questions: ' + (questions || []).join(' | ') + '\n'
  + 'Correction officielle: ' + correction + '\n'
  + 'Bareme: ' + bareme + ' points\n\n'
  + 'Reponse de l\'eleve: ' + studentAnswer + '\n\n'
  + 'Evalue la reponse de l\'eleve. Retourne ce JSON:\n'
  + '{'
  + '"points_obtenus": <nombre entre 0 et ' + bareme + '>,'
  + '"note_sur_20": <note sur 20>,'
  + '"appreciation": "<Excellent/Tres bien/Bien/Passable/A revoir>",'
  + '"correction_detaillee": "<correction etape par etape>",'
  + '"points_positifs": "<ce que l\'eleve a bien fait>",'
  + '"points_ameliorer": "<ce que l\'eleve doit ameliorer>",'
  + '"encouragement": "<message encourageant en arabe et francais>"'
  + '}';

const text   = await callGroq(systemPrompt, userPrompt, true);
const parsed = extractJSON(text);
res.json(parsed);
```

} catch (e) { res.status(500).json({ message: ’Erreur evaluation: ’ + e.message }); }
});

// – AMIS –
app.get(’/api/users/search’, auth, async (req, res) => {
try {
const q = (req.query.q || ‘’).trim();
if (q.length < 2) return res.json([]);
const myFriends = req.user.friends.map(f => f.toString());
const users = await User.find({
_id: { $ne: req.user._id },
$or: [{ firstName: { $regex: q, $options: ‘i’ } }, { lastName: { $regex: q, $options: ‘i’ } }]
}).select(‘firstName lastName’).limit(8);
const enriched = await Promise.all(users.map(async u => {
const isFriend   = myFriends.includes(u._id.toString());
const pendingReq = await FriendReq.findOne({ from: req.user._id, to: u._id, status: ‘pending’ });
return { id: u._id, firstName: u.firstName, lastName: u.lastName, isFriend: isFriend, requestSent: !!pendingReq };
}));
res.json(enriched);
} catch (e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/friends/request’, auth, async (req, res) => {
try {
const { toUserId } = req.body;
if (toUserId === req.user._id.toString())
return res.status(400).json({ message: ‘Tu ne peux pas t ajouter toi-meme’ });
const target = await User.findById(toUserId);
if (!target) return res.status(404).json({ message: ‘Utilisateur introuvable’ });
if (req.user.friends.map(f => f.toString()).includes(toUserId))
return res.status(400).json({ message: ‘Deja amis’ });
const existing = await FriendReq.findOne({ from: req.user._id, to: toUserId, status: ‘pending’ });
if (existing) return res.status(400).json({ message: ‘Demande deja envoyee’ });
await FriendReq.create({ from: req.user._id, to: toUserId });
res.json({ message: ‘Demande envoyee a ’ + target.firstName + ’ ’ + target.lastName + ’ !’ });
} catch (e) { res.status(500).json({ message: e.message }); }
});

app.get(’/api/friends/requests’, auth, async (req, res) => {
try {
const requests = await FriendReq.find({ to: req.user._id, status: ‘pending’ }).populate(‘from’, ‘firstName lastName’);
res.json(requests);
} catch (e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/friends/accept’, auth, async (req, res) => {
try {
const request = await FriendReq.findById(req.body.requestId);
if (!request || request.to.toString() !== req.user._id.toString())
return res.status(403).json({ message: ‘Demande introuvable’ });
request.status = ‘accepted’;
await request.save();
await User.findByIdAndUpdate(req.user._id, { $addToSet: { friends: request.from } });
await User.findByIdAndUpdate(request.from,   { $addToSet: { friends: req.user._id } });
res.json({ message: ‘Ami ajoute !’ });
} catch (e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/friends/decline’, auth, async (req, res) => {
try {
const request = await FriendReq.findById(req.body.requestId);
if (!request || request.to.toString() !== req.user._id.toString())
return res.status(403).json({ message: ‘Demande introuvable’ });
request.status = ‘declined’;
await request.save();
res.json({ message: ‘Demande refusee’ });
} catch (e) { res.status(500).json({ message: e.message }); }
});

app.get(’/api/friends’, auth, async (req, res) => {
try {
const user = await User.findById(req.user._id).populate(‘friends’, ‘firstName lastName compareVisible’);
const list = await Promise.all(user.friends.map(async f => {
const results     = await QuizResult.find({ userId: f._id });
const totalPoints = results.reduce((s, r) => s + (r.points || 0), 0);
const byMatiere   = {};
results.forEach(r => { byMatiere[r.matiere] = (byMatiere[r.matiere] || 0) + (r.points || 0); });
return {
id: f._id, firstName: f.firstName, lastName: f.lastName,
name: f.firstName + ’ ’ + f.lastName,
totalPoints: totalPoints, byMatiere: byMatiere, compareVisible: f.compareVisible
};
}));
res.json(list);
} catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete(’/api/friends/:friendId’, auth, async (req, res) => {
try {
await User.findByIdAndUpdate(req.user._id,       { $pull: { friends: req.params.friendId } });
await User.findByIdAndUpdate(req.params.friendId, { $pull: { friends: req.user._id } });
res.json({ message: ‘Ami supprime’ });
} catch (e) { res.status(500).json({ message: e.message }); }
});

app.patch(’/api/friends/visibility’, auth, async (req, res) => {
try {
await User.findByIdAndUpdate(req.user._id, { compareVisible: req.body.visible });
res.json({ message: ‘Visibilite mise a jour’ });
} catch (e) { res.status(500).json({ message: e.message }); }
});

app.get(’/api/health’, function(req, res) {
res.json({ status: ‘ok’, message: ‘EDUMIND IA Backend (Groq) Running’ });
});

app.listen(process.env.PORT || 5000, function() {
console.log(’EDUMIND Backend running on port ’ + (process.env.PORT || 5000));
});