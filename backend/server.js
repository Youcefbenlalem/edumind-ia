require(‘dotenv’).config();
const express = require(‘express’);
const mongoose = require(‘mongoose’);
const cors = require(‘cors’);
const jwt = require(‘jsonwebtoken’);
const bcrypt = require(‘bcryptjs’);

var app = express();
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
annee: String, filiere: String, matiere: String, lecon: String,
score: Number, total: Number,
points:  { type: Number, default: 0 },
isMath:  { type: Boolean, default: false },
date:    { type: Date, default: Date.now }
});
var User = mongoose.model(‘User’, userSchema);
var FriendReq = mongoose.model(‘FriendRequest’, friendRequestSchema);
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

var GROQ_URL = ‘https://api.groq.com/openai/v1/chat/completions’;
var GROQ_MODEL = ‘llama-3.3-70b-versatile’;
async function callGroq(sys, usr, json) {
var key = process.env.GROQ_API_KEY;
if (!key) throw new Error(‘GROQ_API_KEY manquante’);
var body = { model: GROQ_MODEL, temperature: 0.5, max_tokens: 3000, messages: [{ role: ‘system’, content: sys }, { role: ‘user’, content: usr }] };
if (json) body.response_format = { type: ‘json_object’ };
var r = await fetch(GROQ_URL, { method: ‘POST’, headers: { ‘Content-Type’: ‘application/json’, ‘Authorization’: ‘Bearer ’ + key }, body: JSON.stringify(body) });
var d = await r.json();
if (!r.ok) throw new Error((d.error && d.error.message) || ‘Erreur Groq’);
var t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
if (!t) throw new Error(‘Reponse vide’);
return t;
}
function extractJSON(text) {
var c = text.replace(/`json/g,'').replace(/`/g,’’).trim();
var a = c.indexOf(’{’); var b = c.lastIndexOf(’}’);
if (a===-1||b===-1) throw new Error(‘Pas de JSON’);
return JSON.parse(c.substring(a,b+1));
}

app.post(’/api/auth/register’, async function(req,res) {
try {
var fn=req.body.firstName,ln=req.body.lastName,em=req.body.email,pw=req.body.password;
if (!fn||!ln||!em||!pw) return res.status(400).json({ message: ‘Champs obligatoires’ });
if (await User.findOne({ email: em })) return res.status(400).json({ message: ‘Email deja utilise’ });
var h = await bcrypt.hash(pw,12);
var u = await User.create({ firstName:fn,lastName:ln,email:em,password:h });
res.status(201).json({ token:makeToken(u._id), user:{ id:u._id,firstName:fn,lastName:ln,email:em } });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.post(’/api/auth/login’, async function(req,res) {
try {
var u = await User.findOne({ email: req.body.email });
if (!u||!(await bcrypt.compare(req.body.password,u.password))) return res.status(400).json({ message: ‘Email ou mot de passe incorrect’ });
res.json({ token:makeToken(u._id), user:{ id:u._id,firstName:u.firstName,lastName:u.lastName,email:u.email } });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.get(’/api/stats’, auth, async function(req,res) {
try {
var results = await QuizResult.find({ userId: req.user._id });
var totalPoints = results.reduce(function(s,r){ return s+(r.points||0); },0);
var ds = {}; results.forEach(function(r){ ds[r.date.toDateString()]=true; });
var dates = Object.keys(ds).sort();
var streak = 0;
if (dates.length) { streak=1; for(var i=dates.length-1;i>0;i–){ if((new Date(dates[i])-new Date(dates[i-1]))/86400000===1) streak++; else break; } }
res.json({ totalPoints:totalPoints, quizCompleted:results.length, streak:streak });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.get(’/api/stats/profile’, auth, async function(req,res) {
try {
var results = await QuizResult.find({ userId:req.user._id }).sort({ date:1 });
var totalPoints = results.reduce(function(s,r){ return s+(r.points||0); },0);
var prime = 0;
results.forEach(function(r){ if(r.total>0){ var p=Math.round((r.score/r.total)*100); if(p>prime) prime=p; } });
var bm = {};
results.forEach(function(r){ if(r.matiere) bm[r.matiere]=(bm[r.matiere]||0)+(r.points||0); });
var matiereRanking = Object.keys(bm).map(function(k){ return {name:k,pts:bm[k]}; }).sort(function(a,b){ return b.pts-a.pts; });
var now = new Date(); var labels=[]; var data=[];
for(var w=7;w>=0;w–) {
var ws=new Date(now); ws.setDate(now.getDate()-w*7); ws.setHours(0,0,0,0);
var we=new Date(ws); we.setDate(ws.getDate()+7);
labels.push(‘S’+(8-w));
data.push(results.filter(function(r){ return new Date(r.date)>=ws&&new Date(r.date)<we; }).reduce(function(s,r){ return s+(r.points||0); },0));
}
var tw=data[data.length-1]||0, pw=data[data.length-2]||0;
var progress = pw>0 ? Math.round(((tw-pw)/pw)*100) : (tw>0?100:0);
res.json({ totalPoints:totalPoints,quizCompleted:results.length,prime:prime,matiereRanking:matiereRanking,evolution:{labels:labels,data:data},progress:progress });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.post(’/api/quiz/submit’, auth, async function(req,res) {
try {
var b=req.body;
await QuizResult.create({ userId:req.user._id,score:b.score,total:b.total,matiere:b.matiere,lecon:b.lecon,annee:b.annee,filiere:b.filiere,points:b.points||b.score*10,isMath:b.isMath||false });
res.status(201).json({ message: ‘Score enregistre’ });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.post(’/api/ia/chat’, auth, async function(req,res) {
try {
if (!process.env.GROQ_API_KEY) return res.status(500).json({ message: ‘GROQ_API_KEY manquante’ });
var msgs=req.body.messages||[],annee=req.body.annee,filiere=req.body.filiere,matiere=req.body.matiere;
var parts=[]; if(annee) parts.push(‘Annee:’+annee); if(filiere) parts.push(‘Filiere:’+filiere); if(matiere) parts.push(‘Matiere:’+matiere);
var ctx=parts.join(’|’);
var lastMsg=msgs.length>0?(msgs[msgs.length-1].content||’):’’;
var sys=‘Tu es un professeur expert du programme scolaire algerien (ONEC). ‘+(ctx?‘Contexte:’+ctx+’. ‘:’’)+’ Reponds selon la methodologie algerienne. Arabe/Islam = reponds en arabe, sinon francais. Structure: definition, explication, exemple algerien, regle.’;
var reply = await callGroq(sys,lastMsg,false);
res.json({ reply:reply });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.post(’/api/ia/quiz’, auth, async function(req,res) {
try {
if (!process.env.GROQ_API_KEY) return res.status(500).json({ message: ‘GROQ_API_KEY manquante’ });
var b=req.body;
var isMath=[‘Mathematiques’,‘Physique-Chimie’,‘Sciences Techniques’].indexOf(b.matiere)!==-1;
var ctx=b.annee+(b.filiere?’ ‘+b.filiere:’’)+’ - ‘+b.matiere+’ - ‘+b.lecon+’ - niveau ‘+b.difficulte;
var sys=‘Tu es prof algerien ONEC. JSON valide uniquement, sans markdown.’;
var prompt;
if(isMath) {
prompt=‘4 exercices de ‘+b.matiere+’ pour: ‘+ctx+’. Maths en texte: / fractions ^ puissances racine(). JSON: {“exercices”:[{“numero”:1,“titre”:”…”,“enonce”:”…”,“donnees”:”…”,“questions”:[“1) …”],“correction”:”…”,“bareme”:5},{“numero”:2,“titre”:”…”,“enonce”:”…”,“donnees”:”…”,“questions”:[“1) …”],“correction”:”…”,“bareme”:5},{“numero”:3,“titre”:”…”,“enonce”:”…”,“donnees”:”…”,“questions”:[“1) …”],“correction”:”…”,“bareme”:5},{“numero”:4,“titre”:”…”,“enonce”:”…”,“donnees”:”…”,“questions”:[“1) …”],“correction”:”…”,“bareme”:5}]}’;
} else {
var isAr=[‘Arabe’,‘Education Islamique’,‘Litterature Arabe’].indexOf(b.matiere)!==-1;
prompt=‘8 QCM sur: ‘+ctx+’. ‘+(isAr?‘En arabe.’:‘En francais.’)+’ JSON: {“questions”:[{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:0,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:1,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:2,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:0,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:3,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:1,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:2,“explication”:”…”},{“question”:”…”,“options”:[“A) …”,“B) …”,“C) …”,“D) …”],“correct”:0,“explication”:”…”}]}’;
}
var text=await callGroq(sys,prompt,true);
var parsed=extractJSON(text);
if(!parsed.questions&&!parsed.exercices) throw new Error(‘JSON incorrecte’);
parsed.isMathPhys=isMath;
res.json(parsed);
} catch(e) { res.status(500).json({ message: ‘Erreur: ‘+e.message }); }
});
app.post(’/api/ia/evaluate’, auth, async function(req,res) {
try {
if (!process.env.GROQ_API_KEY) return res.status(500).json({ message: ‘GROQ_API_KEY manquante’ });
var b=req.body;
var sys=‘Tu es correcteur algerien ONEC. JSON valide uniquement.’;
var prompt=‘Exercice ‘+b.matiere+’ (’+b.annee+’). Enonce:’+b.enonce+’. ‘+(b.donnees?‘Donnees:’+b.donnees+’. ‘:’’)+‘Questions:’+(b.questions||[]).join(’|’)+’. Correction:’+b.correction+’. Bareme:’+b.bareme+’. Reponse eleve:’+b.studentAnswer+’. JSON:{“points_obtenus”:0,“note_sur_20”:0,“appreciation”:”…”,“correction_detaillee”:”…”,“points_positifs”:”…”,“points_ameliorer”:”…”,“encouragement”:”…”}’;
var parsed=extractJSON(await callGroq(sys,prompt,true));
res.json(parsed);
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.get(’/api/users/search’, auth, async function(req,res) {
try {
var q=(req.query.q||’’).trim(); if(q.length<2) return res.json([]);
var mf=req.user.friends.map(function(f){ return f.toString(); });
var users=await User.find({ _id:{$ne:req.user._id},$or:[{firstName:{$regex:q,$options:‘i’}},{lastName:{$regex:q,$options:‘i’}}] }).select(‘firstName lastName’).limit(8);
var enriched=await Promise.all(users.map(async function(u) {
var pr=await FriendReq.findOne({ from:req.user._id,to:u._id,status:‘pending’ });
return { id:u._id,firstName:u.firstName,lastName:u.lastName,isFriend:mf.indexOf(u._id.toString())!==-1,requestSent:!!pr };
}));
res.json(enriched);
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.post(’/api/friends/request’, auth, async function(req,res) {
try {
var tid=req.body.toUserId;
if(tid===req.user._id.toString()) return res.status(400).json({ message: ‘Tu ne peux pas t ajouter toi-meme’ });
var t=await User.findById(tid); if(!t) return res.status(404).json({ message: ‘Introuvable’ });
if(req.user.friends.map(function(f){ return f.toString(); }).indexOf(tid)!==-1) return res.status(400).json({ message: ‘Deja amis’ });
if(await FriendReq.findOne({ from:req.user._id,to:tid,status:‘pending’ })) return res.status(400).json({ message: ‘Deja envoye’ });
await FriendReq.create({ from:req.user._id,to:tid });
res.json({ message:‘Demande envoyee a ‘+t.firstName+’ ‘+t.lastName });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.get(’/api/friends/requests’, auth, async function(req,res) {
try { res.json(await FriendReq.find({ to:req.user._id,status:‘pending’ }).populate(‘from’,‘firstName lastName’)); }
catch(e) { res.status(500).json({ message: e.message }); }
});
app.post(’/api/friends/accept’, auth, async function(req,res) {
try {
var r=await FriendReq.findById(req.body.requestId);
if(!r||r.to.toString()!==req.user._id.toString()) return res.status(403).json({ message: ‘Introuvable’ });
r.status=‘accepted’; await r.save();
await User.findByIdAndUpdate(req.user._id,{$addToSet:{friends:r.from}});
await User.findByIdAndUpdate(r.from,{$addToSet:{friends:req.user._id}});
res.json({ message:‘Ami ajoute’ });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.post(’/api/friends/decline’, auth, async function(req,res) {
try {
var r=await FriendReq.findById(req.body.requestId);
if(!r||r.to.toString()!==req.user._id.toString()) return res.status(403).json({ message: ‘Introuvable’ });
r.status=‘declined’; await r.save(); res.json({ message:‘Demande refusee’ });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.get(’/api/friends’, auth, async function(req,res) {
try {
var u=await User.findById(req.user._id).populate(‘friends’,‘firstName lastName compareVisible’);
var list=await Promise.all(u.friends.map(async function(f) {
var rs=await QuizResult.find({ userId:f._id });
var tp=rs.reduce(function(s,r){ return s+(r.points||0); },0);
var bm={}; rs.forEach(function(r){ bm[r.matiere]=(bm[r.matiere]||0)+(r.points||0); });
return { id:f._id,firstName:f.firstName,lastName:f.lastName,name:f.firstName+’ ‘+f.lastName,totalPoints:tp,byMatiere:bm,compareVisible:f.compareVisible };
}));
res.json(list);
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.delete(’/api/friends/:friendId’, auth, async function(req,res) {
try {
await User.findByIdAndUpdate(req.user._id,{$pull:{friends:req.params.friendId}});
await User.findByIdAndUpdate(req.params.friendId,{$pull:{friends:req.user._id}});
res.json({ message:‘Ami supprime’ });
} catch(e) { res.status(500).json({ message: e.message }); }
});
app.patch(’/api/friends/visibility’, auth, async function(req,res) {
try { await User.findByIdAndUpdate(req.user._id,{ compareVisible:req.body.visible }); res.json({ message:‘OK’ }); }
catch(e) { res.status(500).json({ message: e.message }); }
});
app.get(’/api/health’, function(req,res) { res.json({ status:‘ok’, message:‘EDUMIND Groq Running’ }); });
app.listen(process.env.PORT||5000, function() { console.log(’EDUMIND running on port ’+(process.env.PORT||5000)); });