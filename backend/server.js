// ── IA PROXY ──
const callClaude = async (system, userMsg, maxTokens = 2000) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-3-5-haiku-20241022', max_tokens:maxTokens, system, messages:[{role:'user',content:userMsg}] })
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
      body: JSON.stringify({ model:'claude-3-5-haiku-20241022', max_tokens:1500, system, messages })
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ message: data.error?.message || 'Erreur Claude' });
    const reply = data.content?.map(c=>c.text||'').join('') || '';
    res.json({ reply });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
