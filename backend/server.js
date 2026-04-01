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
.then(function() { console.log(‘MongoDB connected’); })
.catch(function(err) { console.error(‘MongoDB error:’, err); });

var userSchema = new mongoose.Schema({
firstName:      { type: String, required: true },
lastName:       { type: String, required: true },
email:          { type: String, required: true, unique: true, lowercase: true },
password:       { type: String, required: true },
friends:        [{ type: mongoose.Schema.Types.ObjectId, ref: ‘User’ }],
compareVisible: { type: Boolean, default: true },
createdAt:      { type: Date, default: Date.now }
});

var friendRequestSchema = new mongoose.Schema({
from:      { type: mongoose.Schema.Types.ObjectId, ref: ‘User’, required: true },
to:        { type: mongoose.Schema.Types.ObjectId, ref: ‘User’, required: true },
status:    { type: String, enum: [‘pending’,‘accepted’,‘declined’], default: ‘pending’ },
createdAt: { type: Date, default: Date.now }
});

var quizResultSchema = new mongoose.Schema({
userId:  { type: mongoose.Schema.Types.ObjectId, ref: ‘User’, required: true },
annee:   String, filiere: String, matiere: String, lecon: String,
score:   Number, total: Number,
points:  { type: Number, default: 0 },
isMath:  { type: Boolean, default: false },
date:    { type: Date, default: Date.now }
});

var User       = mongoose.model(‘User’, userSchema);
var FriendReq  = mongoose.model(‘FriendRequest’, friendRequestSchema);
var QuizResult = mongoose.model(‘QuizResult’, quizResultSchema);

var JWT_SECRET = process.env.JWT_SECRET || ‘edumind_secret_key’;
function makeToken(id) { return jwt.sign({ id: id }, JWT_SECRET, { expiresIn: ‘30d’ }); }

async function auth(req, res, next) {
var token = (req.headers.authorization || ‘’).replace(‘Bearer ‘, ‘’);
if (!token) return res.status(401).json({ message: ‘Non authentifie’ });
try {
var decoded = jwt.verify(token, JWT_SECRET);
req.user = await User.findById(decoded.id).select(’-password’);
if (!req.user) return res.status(401).json({ message: ‘Utilisateur introuvable’ });
next();
} catch(e) { res.status(401).json({ message: ‘Token invalide’ }); }
}

var GROQ_MODEL = ‘llama-3.3-70b-versatile’;
var GROQ_URL   = ‘https://api.groq.com/openai/v1/chat/completions’;

async function callGroq(systemPrompt, userPrompt, jsonMode) {
var key = process.env.GROQ_API_KEY;
if (!key) throw new Error(‘GROQ_API_KEY manquante sur Render’);
var body = {
model: GROQ_MODEL,
temperature: 0.5,
max_tokens: 3000,
messages: [
{ role: ‘system’, content: systemPrompt },
{ role: ‘user’,   content: userPrompt   }
]
};
if (jsonMode) body.response_format = { type: ‘json_object’ };
var r = await fetch(GROQ_URL, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’, ‘Authorization’: ’Bearer ’ + key },
body: JSON.stringify(body)
});
var d = await r.json();
if (!r.ok) throw new Error((d.error && d.error.message) || (’Erreur Groq ’ + r.status));
var text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || ‘’;
if (!text) throw new Error(‘Groq a retourne une reponse vide’);
return text;
}

function extractJSON(text) {
var clean = text.replace(/`json/g, '').replace(/`/g, ‘’).trim();
var a = clean.indexOf(’{’);
var b = clean.lastIndexOf(’}’);
if (a === -1 || b === -1) throw new Error(‘Aucun JSON dans la reponse’);
return JSON.parse(clean.substring(a, b + 1));
}

app.post(’/api/auth/register’, async function(req, res) {
try {
var firstName = req.body.firstName;
var lastName  = req.body.lastName;
var email     = req.body.email;
var password  = req.body.password;
if (!firstName || !lastName || !email || !password)
return res.status(400).json({ message: ‘Tous les champs sont obligatoires’ });
if (await User.findOne({ email: email }))
return res.status(400).json({ message: ‘Email deja utilise’ });
var hashed = await bcrypt.hash(password, 12);
var user   = await User.create({ firstName: firstName, lastName: lastName, email: email, password: hashed });
res.status(201).json({ token: makeToken(user._id), user: { id: user._id, firstName: firstName, lastName: lastName, email: email } });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/auth/login’, async function(req, res) {
try {
var email    = req.body.email;
var password = req.body.password;
var user = await User.findOne({ email: email });
if (!user || !(await bcrypt.compare(password, user.password)))
return res.status(400).json({ message: ‘Email ou mot de passe incorrect’ });
res.json({ token: makeToken(user._id), user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email } });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.get(’/api/stats’, auth, async function(req, res) {
try {
var results     = await QuizResult.find({ userId: req.user._id });
var totalPoints = results.reduce(function(s, r) { return s + (r.points || 0); }, 0);
var dateSet = {};
results.forEach(function(r) { dateSet[r.date.toDateString()] = true; });
var dates = Object.keys(dateSet).sort();
var streak = 0;
if (dates.length) {
streak = 1;
for (var i = dates.length - 1; i > 0; i–) {
if ((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000 === 1) streak++;
else break;
}
}
res.json({ totalPoints: totalPoints, quizCompleted: results.length, streak: streak });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.get(’/api/stats/profile’, auth, async function(req, res) {
try {
var results     = await QuizResult.find({ userId: req.user._id }).sort({ date: 1 });
var totalPoints = results.reduce(function(s, r) { return s + (r.points || 0); }, 0);
var prime = 0;
results.forEach(function(r) {
if (r.total > 0) {
var pct = Math.round((r.score / r.total) * 100);
if (pct > prime) prime = pct;
}
});
var byMatiere = {};
results.forEach(function(r) {
if (r.matiere) byMatiere[r.matiere] = (byMatiere[r.matiere] || 0) + (r.points || 0);
});
var matiereRanking = Object.keys(byMatiere)
.map(function(k) { return { name: k, pts: byMatiere[k] }; })
.sort(function(a, b) { return b.pts - a.pts; });
var now = new Date();
var labels = [];
var data   = [];
for (var w = 7; w >= 0; w–) {
var wStart = new Date(now);
wStart.setDate(now.getDate() - w * 7);
wStart.setHours(0, 0, 0, 0);
var wEnd = new Date(wStart);
wEnd.setDate(wStart.getDate() + 7);
labels.push(‘S’ + (8 - w));
var pts = results
.filter(function(r) { return new Date(r.date) >= wStart && new Date(r.date) < wEnd; })
.reduce(function(s, r) { return s + (r.points || 0); }, 0);
data.push(pts);
}
var thisWeek = data[data.length - 1] || 0;
var prevWeek = data[data.length - 2] || 0;
var progress = prevWeek > 0 ? Math.round(((thisWeek - prevWeek) / prevWeek) * 100) : (thisWeek > 0 ? 100 : 0);
res.json({ totalPoints: totalPoints, quizCompleted: results.length, prime: prime, matiereRanking: matiereRanking, evolution: { labels: labels, data: data }, progress: progress });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/quiz/submit’, auth, async function(req, res) {
try {
var score   = req.body.score;
var total   = req.body.total;
var matiere = req.body.matiere;
var lecon   = req.body.lecon;
var annee   = req.body.annee;
var filiere = req.body.filiere;
var points  = req.body.points || score * 10;
var isMath  = req.body.isMath || false;
await QuizResult.create({ userId: req.user._id, score: score, total: total, matiere: matiere, lecon: lecon, annee: annee, filiere: filiere, points: points, isMath: isMath });
res.status(201).json({ message: ‘Score enregistre’ });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/ia/chat’, auth, async function(req, res) {
try {
if (!process.env.GROQ_API_KEY) return res.status(500).json({ message: ‘GROQ_API_KEY manquante’ });
var messages = req.body.messages || [];
var annee    = req.body.annee;
var filiere  = req.body.filiere;
var matiere  = req.body.matiere;
var parts = [];
if (annee)   parts.push(’Annee: ’ + annee);
if (filiere) parts.push(’Filiere: ’ + filiere);
if (matiere) parts.push(‘Matiere: ’ + matiere);
var ctx     = parts.join(’ | ’);
var lastMsg = messages.length > 0 ? (messages[messages.length - 1].content || ‘’) : ‘’;
var sys = ’Tu es un professeur expert du programme scolaire algerien officiel (ONEC). ’
+ (ctx ? ’Contexte eleve: ’ + ctx + ’. ’ : ‘’)
+ ’Reponds selon la methodologie algerienne. Si Arabe ou Education Islamique reponds en arabe, sinon en francais. ’
+ ‘Structure: definition, explication, exemple algerien concret, regle a retenir.’;
var reply = await callGroq(sys, lastMsg, false);
res.json({ reply: reply });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/ia/quiz’, auth, async function(req, res) {
try {
if (!process.env.GROQ_API_KEY) return res.status(500).json({ message: ‘GROQ_API_KEY manquante’ });
var annee      = req.body.annee;
var filiere    = req.body.filiere;
var matiere    = req.body.matiere;
var lecon      = req.body.lecon;
var difficulte = req.body.difficulte;
var mathMatieres = [‘Mathematiques’, ‘Physique-Chimie’, ‘Sciences Techniques’];
var isMathPhys = mathMatieres.indexOf(matiere) !== -1;
var ctx = annee + (filiere ? ’ ’ + filiere : ‘’) + ’ - ’ + matiere + ’ - ’ + lecon + ’ - niveau ’ + difficulte;
var sys = ‘Tu es un professeur expert du programme scolaire algerien officiel (ONEC). Tu generes des questions STRICTEMENT conformes au programme algerien. Tu reponds UNIQUEMENT en JSON valide sans markdown.’;
var prompt;
if (isMathPhys) {
prompt = ’Cree 4 exercices de ’ + matiere + ’ pour: ’ + ctx + ‘. Ecris les maths en texte simple: / fractions, ^ puissances, racine() racines. Pas de LaTeX. JSON: {“exercices”:[{“numero”:1,“titre”:”…”,“enonce”:”…”,“donnees”:”…”,“questions”:[“1) …”],“correction”:”…”,“bareme”:5},{“numero”:2,“titre”:”…”,“enonce”:”…”,“donnees”:”…”,“questions”:[“1) …”],“correction”:”…”,“bareme”:5},{“numero”:3,“titre”:”…”,“enonce”:”…”,“donnees”:”…”,“questions”:[“1) …”],“correction”:”…”,“bareme”:5},{“numero”:4,“titre”:”…”,“enonce”:”…”,“donnees”:”…”,“questions”:[“1) …”],“correction”:”…”,“bareme”:5}]}’;
} else {
var arabeMatieres = [‘Arabe’, ‘Education Islamique’, ‘Litterature Arabe’];
var isArabe = arabeMatieres.indexOf(matiere) !== -1;
prompt = ’Cree 8 QCM sur: ’ + ctx + ‘. ’ + (isArabe ? ‘En arabe.’ : ‘En francais.’) + ’ JSON: {“questions”:[{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:0,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:1,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:2,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:0,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:3,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:1,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:2,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:0,“explication”:”…”}]}’;
}
var text   = await callGroq(sys, prompt, true);
var parsed = extractJSON(text);
if (!parsed.questions && !parsed.exercices) throw new Error(‘Structure JSON incorrecte’);
parsed.isMathPhys = isMathPhys;
res.json(parsed);
} catch(e) { res.status(500).json({ message: ’Erreur generation: ’ + e.message }); }
});

app.post(’/api/ia/evaluate’, auth, async function(req, res) {
try {
if (!process.env.GROQ_API_KEY) return res.status(500).json({ message: ‘GROQ_API_KEY manquante’ });
var enonce        = req.body.enonce;
var donnees       = req.body.donnees;
var questions     = req.body.questions || [];
var correction    = req.body.correction;
var studentAnswer = req.body.studentAnswer;
var bareme        = req.body.bareme;
var matiere       = req.body.matiere;
var annee         = req.body.annee;
var sys = ‘Tu es un professeur correcteur expert du programme scolaire algerien. Tu corriges avec bienveillance. Tu reponds UNIQUEMENT en JSON valide.’;
var prompt = ‘Exercice de ’ + matiere + ’ (’ + annee + ’). Enonce: ’ + enonce + ’. ’ + (donnees ? ’Donnees: ’ + donnees + ’. ’ : ‘’) + ‘Questions: ’ + questions.join(’ | ’) + ’. Correction: ’ + correction + ’. Bareme: ’ + bareme + ’ pts. Reponse eleve: ’ + studentAnswer + ‘. Retourne: {“points_obtenus”:0,“note_sur_20”:0,“appreciation”:”…”,“correction_detaillee”:”…”,“points_positifs”:”…”,“points_ameliorer”:”…”,“encouragement”:”…”}’;
var text   = await callGroq(sys, prompt, true);
var parsed = extractJSON(text);
res.json(parsed);
} catch(e) { res.status(500).json({ message: ’Erreur evaluation: ’ + e.message }); }
});

app.get(’/api/users/search’, auth, async function(req, res) {
try {
var q = (req.query.q || ‘’).trim();
if (q.length < 2) return res.json([]);
var myFriends = req.user.friends.map(function(f) { return f.toString(); });
var users = await User.find({ _id: { $ne: req.user._id }, $or: [{ firstName: { $regex: q, $options: ‘i’ } }, { lastName: { $regex: q, $options: ‘i’ } }] }).select(‘firstName lastName’).limit(8);
var enriched = await Promise.all(users.map(async function(u) {
var isFriend   = myFriends.indexOf(u._id.toString()) !== -1;
var pendingReq = await FriendReq.findOne({ from: req.user._id, to: u._id, status: ‘pending’ });
return { id: u._id, firstName: u.firstName, lastName: u.lastName, isFriend: isFriend, requestSent: !!pendingReq };
}));
res.json(enriched);
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/friends/request’, auth, async function(req, res) {
try {
var toUserId = req.body.toUserId;
if (toUserId === req.user._id.toString()) return res.status(400).json({ message: ‘Tu ne peux pas t ajouter toi-meme’ });
var target = await User.findById(toUserId);
if (!target) return res.status(404).json({ message: ‘Utilisateur introuvable’ });
var myFriends = req.user.friends.map(function(f) { return f.toString(); });
if (myFriends.indexOf(toUserId) !== -1) return res.status(400).json({ message: ‘Deja amis’ });
var existing = await FriendReq.findOne({ from: req.user._id, to: toUserId, status: ‘pending’ });
if (existing) return res.status(400).json({ message: ‘Demande deja envoyee’ });
await FriendReq.create({ from: req.user._id, to: toUserId });
res.json({ message: ’Demande envoyee a ’ + target.firstName + ’ ’ + target.lastName });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.get(’/api/friends/requests’, auth, async function(req, res) {
try {
var requests = await FriendReq.find({ to: req.user._id, status: ‘pending’ }).populate(‘from’, ‘firstName lastName’);
res.json(requests);
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/friends/accept’, auth, async function(req, res) {
try {
var request = await FriendReq.findById(req.body.requestId);
if (!request || request.to.toString() !== req.user._id.toString()) return res.status(403).json({ message: ‘Demande introuvable’ });
request.status = ‘accepted’;
await request.save();
await User.findByIdAndUpdate(req.user._id, { $addToSet: { friends: request.from } });
await User.findByIdAndUpdate(request.from, { $addToSet: { friends: req.user._id } });
res.json({ message: ‘Ami ajoute’ });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.post(’/api/friends/decline’, auth, async function(req, res) {
try {
var request = await FriendReq.findById(req.body.requestId);
if (!request || request.to.toString() !== req.user._id.toString()) return res.status(403).json({ message: ‘Demande introuvable’ });
request.status = ‘declined’;
await request.save();
res.json({ message: ‘Demande refusee’ });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.get(’/api/friends’, auth, async function(req, res) {
try {
var user = await User.findById(req.user._id).populate(‘friends’, ‘firstName lastName compareVisible’);
var list = await Promise.all(user.friends.map(async function(f) {
var results     = await QuizResult.find({ userId: f._id });
var totalPoints = results.reduce(function(s, r) { return s + (r.points || 0); }, 0);
var byMatiere   = {};
results.forEach(function(r) { byMatiere[r.matiere] = (byMatiere[r.matiere] || 0) + (r.points || 0); });
return { id: f._id, firstName: f.firstName, lastName: f.lastName, name: f.firstName + ’ ’ + f.lastName, totalPoints: totalPoints, byMatiere: byMatiere, compareVisible: f.compareVisible };
}));
res.json(list);
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.delete(’/api/friends/:friendId’, auth, async function(req, res) {
try {
await User.findByIdAndUpdate(req.user._id,       { $pull: { friends: req.params.friendId } });
await User.findByIdAndUpdate(req.params.friendId, { $pull: { friends: req.user._id } });
res.json({ message: ‘Ami supprime’ });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.patch(’/api/friends/visibility’, auth, async function(req, res) {
try {
await User.findByIdAndUpdate(req.user._id, { compareVisible: req.body.visible });
res.json({ message: ‘Visibilite mise a jour’ });
} catch(e) { res.status(500).json({ message: e.message }); }
});

app.get(’/api/health’, function(req, res) {
res.json({ status: ‘ok’, message: ‘EDUMIND IA Backend Groq Running’ });
});

app.listen(process.env.PORT || 5000, function() {
console.log(’EDUMIND Backend running on port ’ + (process.env.PORT || 5000));
});