// Professor AI — 500 rotating professional tips (chat hero + agent empty state).
// Typewriter animation, rotation every 15s, language: English.
window.PFTips = (() => {
  // Tech / AI / future tips (rotating in the chat hero)
  const CHAT_TIPS = [
    "AI models scale with compute and data — but alignment decides whether that intelligence helps or harms.",
    "Transformers process every token in parallel — that single design choice unlocked modern LLMs.",
    "GPT-style models predict ONE token at a time; the illusion of thinking emerges from next-word prediction.",
    "An LLM has no memory between chats — everything it \"remembers\" is re-read from the context window.",
    "Context windows are the working memory of AI: 128k tokens ≈ a 300-page book per conversation.",
    "Hallucination isn't a bug — it's the model confidently continuing a pattern with no grounding data.",
    "RAG (retrieval-augmented generation) gives models fresh facts: search first, then answer.",
    "Fine-tuning teaches style; retrieval teaches facts; prompt engineering teaches behavior.",
    "Quantization (4-bit) can shrink a 70B model onto a laptop with ~10% quality loss.",
    "Distillation transfers a big model's skill into a small one — how compact phone AI is born.",
    "MoE (Mixture of Experts) models activate only a fraction of parameters per token — giant models, cheap inference.",
    "Chain-of-thought prompting measurably improves reasoning — models think better when they \"show their work\".",
    "Multi-agent systems beat single models on complex tasks — a planner, a builder, and a critic outperform one generalist.",
    "The bitter lesson of AI: general methods + compute beat hand-crafted cleverness, every decade, again.",
    "Neural networks are differentiable stacks of matrix multiplies — that's literally all they are.",
    "Backpropagation is the chain rule from calculus, applied backwards through millions of layers.",
    "Scaling laws predicted model quality before it was observed — power laws govern AI progress.",
    "Alignment is unsolved: we can make capable models, but reliably steering them is open science.",
    "An open-weights model is NOT open source — you can run it, but you can't see the training data or code.",
    "Quantum computing threatens RSA encryption only in theory — for now, classical crypto is safe.",
    "Post-quantum cryptography is already standardized (NIST 2024) — the migration has quietly begun.",
    "Zero-knowledge proofs let you prove a fact without revealing the fact — math magic behind private blockchains.",
    "Homomorphic encryption computes on encrypted data — the cloud processes your data without seeing it.",
    "Federated learning trains a global model without your data leaving your phone.",
    "Differential privacy adds calibrated noise so statistics survive while individuals stay hidden.",
    "The GPU shortage defined a decade — AI progress is downstream of chip fabrication capacity.",
    "TPUs, NPUs, and custom silicon: the chip war decides which nation leads in AI.",
    "Energy is the true constraint: training frontier models consumes city-scale electricity.",
    "Data centers now compete for nuclear power — the future of computing is a power-grid problem.",
    "Edge AI moves inference to your device — faster, private, and free of subscription costs.",
    "On-device models passed the usefulness threshold: 3B parameters now beat 2020's 175B giants.",
    "Speculative decoding uses a small model to draft and a big model to verify — 2-3x faster inference.",
    "KV-caching is why streaming AI answers accelerate — the model never re-reads what it already processed.",
    "Semantic search understands meaning, not keywords — embeddings turn text into direction in meaning-space.",
    "Vectors make similarity math: cosine distance between embeddings = conceptual distance between ideas.",
    "Multimodal models share one embedding space for text, image, and audio — meaning is meaning, regardless of form.",
    "Diffusion models generate images by learning to reverse noise — random static slowly becomes structure.",
    "The best prompt format: role, task, context, constraints, examples — clarity beats cleverness.",
    "Temperature 0 = deterministic (for code), temperature 0.8 = creative (for prose).",
    "Tokens ≠ words: English averages ~1.3 tokens per word; Persian and CJK cost more per idea.",
    "Compound AI systems — retrievers, verifiers, tools, orchestrators — are the real product; the model is a component.",
    "AI agents = model + memory + tools + loop. The loop is where the engineering lives.",
    "Tool use turned LLMs into hands: function calling is how a model acts on the world.",
    "The 2025 agent shift: from chat (ask-answer) to delegation (hand off the whole task).",
    "Self-correcting agents — generate, run, read the error, fix — beat one-shot generation every time.",
    "Code is the easiest tool for AI: compilers give perfect, instant feedback on correctness.",
    "Vibe coding: describe the app, let AI build it — 2025's fastest-growing programming paradigm.",
    "The IDE is dissolving into conversation — the terminal, editor, and browser merge into one chat surface.",
    "GitHub Copilot writes ~46% of code in enabled files — AI pair-programming is now the default.",
    "Software 2.0: the model IS the program. Prompts are the new source code.",
    "Your most valuable future skill: precisely specifying what you want — specification is the new programming.",
    "AI won't replace engineers; engineers who use AI replace engineers who don't.",
    "The bottleneck moved from writing code to reviewing it — judgment is the scarce resource now.",
    "Prompt injection is the new SQL injection — any text an AI reads is potential instructions.",
    "Never let an AI agent browse untrusted pages with your credentials — injection attacks are unsolved.",
    "Sandboxing agents is mandatory: AI with tools needs the same isolation as any untrusted program.",
    "Model cards and evals are the nutrition labels of AI — read them before you deploy.",
    "Benchmark contamination: models memorize test answers; real capability is lower than leaderboards suggest.",
    "Evals are harder than models: measuring intelligence is its own open research problem.",
    "Emergent abilities appear suddenly with scale — capabilities nobody engineered just show up.",
    "In-context learning: a model learns a NEW task from examples in the prompt alone — no training, no fine-tune.",
    "Instruction tuning + RLHF is why modern assistants answer instead of just continuing text.",
    "RLHF optimizes for human preference — which is why models sound confident even when wrong.",
    "Constitutional AI: give the model a written constitution and let it critique its own outputs.",
    "Interpretability is coming online: sparse autoencoders now decode individual features inside live models.",
    "We found 'truth directions' inside models — geometry of belief is becoming measurable.",
    "Mechanistic interpretability aims to reverse-engineer neural nets like compiled binaries.",
    "The alignment problem scales: capabilities generalize; alignment generalizes worse — that's the danger.",
    "AGI debates are really about definitions — the capability curve doesn't care about our vocabulary.",
    "Every capability jump shrinks the time between 'impossible' and 'obsolete'.",
    "The jobs first transformed by AI: translation, copywriting, customer support, junior coding — in that rough order.",
    "Tasks decompose, jobs recombine — AI takes tasks, humans keep jobs that become AI-supervising.",
    "The economic value of AI sits in boring domains: logistics, paperwork, back-office — not sci-fi.",
    "Science is AI's killer app: protein folding, weather models, chip design, and drug discovery run on AI now.",
    "AlphaFold solved 50 years of protein structure — 200M+ structures predicted, a Nobel for the team.",
    "AI weather models (GraphCast) now beat classical supercomputer simulations on 10-day forecasts.",
    "Materials discovery via AI: millions of candidate crystals predicted — batteries and superconductors next.",
    "Self-driving is a solved problem in geometric domains; the last 1% of edge cases eats decades.",
    "LLM+robotics = the embodiment gap: language models understand the world but never touched it.",
    "World models — AI that simulates physics in imagination — are the next architecture race.",
    "Video generation is a world model in disguise — you can't fake coherent physics without learning physics.",
    "Real-time generation is the end of loading screens — content renders as you look at it.",
    "Digital twins simulate factories, cities, and bodies — AI mirrors run the what-ifs before reality does.",
    "The metaverse failed on hardware; AI companions accidentally built its social layer instead.",
    "Voice latency below 300ms feels human — real-time speech AI erased the telephone-barrier.",
    "Simultaneous AI translation with 2-second delay is live — language barriers are dissolving in real time.",
    "Personal AI memory changes products: an assistant that remembers your context across months.",
    "Privacy is the price of personalization — local models are the counter-movement that keeps both.",
    "Open models (Llama, Qwen, Mistral) closed the gap to closed frontier labs to months, not years.",
    "The inference cost curve: what cost $1 per million tokens in 2023 costs fractions of a cent today.",
    "AI price collapse follows Moore-meets-Learning curves — intelligence gets cheap like storage did.",
    "When intelligence is nearly free, the scarce assets are: taste, trust, data, and distribution.",
    "Data is the new oil is wrong twice — data is the new PLASTIC: valuable, abundant, and polluting.",
    "Synthetic data works when it's verified — the best models now train on their own graded outputs.",
    "The data wall: the internet is nearly exhausted of fresh text; experience data (agent traces) is the next mine.",
    "Copyright vs. training data is the legal fault line of the decade — the rulings will shape who builds AI.",
    "Watermarking AI text is trivially removable; watermarking AI images is holding — provenance, not detection, is the answer.",
    "C2PA content credentials — cryptographic provenance for media — is quietly becoming infrastructure.",
    "Deepfakes shift the burden of proof: seeing stopped being believing around 2018.",
    "The strongest defense against deepfakes isn't detection — it's pre-agreed verification signals.",
    "AI literacy beats AI fear: know what models can't do (guaranteed facts, arithmetic, current events) and you're armored.",
    "Model collapse: training on AI outputs degrades the lineage — provenance of training data is survival-critical.",
    "Every interface becomes conversational — but great conversational UI hides the conversation when a button is faster.",
    "The 90-9-1 of AI products: 90% try once, 9% weekly, 1% build their workflow around it — retention is everything.",
    "Vertical AI beats horizontal: a model that knows legal citations cold beats a generalist on legal work.",
    "The best AI products hide the model: users want outcomes; the model is plumbing.",
    "Latency is UX: 200ms feels instant, 2s feels slow, 10s feels broken — AI products live and die on time-to-first-token.",
    "Streaming answers changes psychology: an answer that grows feels 5x faster than one that arrives.",
    "Every 'AI wrapper' app with a real workflow becomes a real business — the wrapper is the distribution.",
    "Context engineering > prompt engineering in the agent era: what the model sees IS the product.",
    "Memory architecture decides agent quality: episodic (what happened), semantic (what's true), procedural (how we work).",
    "Agent reliability is a systems problem: retries, validation, idempotency — boring engineering beats clever prompts.",
    "The most underrated AI feature: a stop button and a resume button — human control is a feature, not a limitation.",
    "Human-in-the-loop scales trust: AI drafts, human approves — the approval step is where quality lives.",
    "Explainability is a legal requirement arriving: the EU AI Act forces 'why' for high-stakes decisions.",
    "The EU AI Act (2024) is the world's first comprehensive AI law — compliance engineering is now a career.",
    "AI safety's most practical near-term issue isn't rogue superintelligence — it's scams, spam, and cheap manipulation.",
    "AI spam is a red Queen race: generation cost falls to zero, filter cost stays — verification becomes the business.",
    "The agentic web is coming: sites will publish machine-readable actions (like APIs, but for agents).",
    "LLMs.txt — a robots.txt for AI agents — is quietly standardizing how models read the web.",
    "Your personal AI will hold your credentials eventually — secure delegation protocols are the unsolved gap.",
    "MCP (Model Context Protocol) standardizes tool connections — USB ports for AI, one protocol for every integration.",
    "Agents that pay: AI + crypto wallets + spending limits is the next trust boundary we'll have to engineer.",
    "The scarcest 2030 skill: asking the right question when answers are infinite.",
    "Code literacy becomes AI-native literacy: reading generated code safely matters more than writing it by hand.",
    "The half-life of technical knowledge keeps shrinking — learning velocity beats knowledge stock.",
    "Future-forward careers pair deep domain expertise with AI leverage: domain + model beats either alone.",
    "The quantum timeline: error correction milestones now double yearly — fault tolerance this decade is plausible.",
    "Neuromorphic chips compute like brains — spikes, not clocks — promising AI at a watt instead of a megawatt.",
    "Photonic computing moves matrix math to light — AI inference at the speed of photons is in the lab now.",
    "3D chip stacking and chiplets extend Moore's law by building up, not shrinking down.",
    "The end of silicon was predicted 20 times; materials science keeps postponing it — gallium, graphene, DNA origami.",
    "DNA storage fits 215PB per gram — the archive of civilization fits in a sugar cube.",
    "Brain-computer interfaces restored speech to paralyzed patients — Neuralink-style implants are in human trials.",
    "BCI reads intention, not thoughts — 2020s interfaces decode motor signals, not inner monologue.",
    "Methylene longevity, GLP-1 drugs, AI diagnostics: healthspan extended while AI compresses the discovery cycle.",
    "AI drug candidates are in Phase II trials — designed in months, not years, for targets humans never found.",
    "AlphaProof earned a silver-medal level at the International Math Olympiad — formal math is falling to AI.",
    "Formal verification + AI = self-proving software — code that carries its own mathematical correctness proof.",
    "Lean + AI mathematicians: every proof verified, no human referee needed — mathematics industrialized.",
    "The AI scientist that runs its own lab — hypothesis, experiment, analysis, paper — already exists in prototype.",
    "Automated research compounds: AI building AI is the recursive loop that worries the serious people.",
    "Recursive self-improvement is bounded by compute and data — for now.",
    "The decade's real question: can institutions absorb change this fast? Technology is ready; governance is the laggard.",
    "Every prediction about AI in the 2010s was too pessimistic for 2025 — hold your 2030 predictions with humility.",
    "Amara's law: we overestimate tech in 2 years, underestimate in 10 — AI is currently doing both at once.",
    "The future arrives unevenly — AI writes code in SF while fax machines run hospitals elsewhere.",
    "The most futuristic technology always looks like a toy first — mainframe, PC, internet, phone, chatbot, agent.",
    "Whatever is next after transformers, it will look unnecessary to experts — then obvious in hindsight.",
  ];


  const AGENT_TIPS = [
    "Describe the app, game, or site — the agent plans, builds every file, and runs it live.",
    "Say 'build a 3D first-person shooter' — full pointer-lock camera, WASD, enemies, HUD included.",
    "Ask for fixes anytime: 'the button does nothing' — the agent reads its own files and repairs.",
    "Non-browser languages work too: Python, C++, Java — the Files tab shows every source.",
    "Download the whole project as ZIP with one click.",
    "The preview console shows live errors — auto-fix repairs them automatically.",
    "One file per ```file: block — the workbench upserts and reloads instantly.",
    "Themes are honored exactly: name a palette or give hex codes.",
    "Games come complete: menu, controls, win/lose, restart — zero dead buttons.",
    "Multi-file projects sync: HTML ↔ CSS ↔ JS references always match.",
    "Persian projects get a full RTL Persian UI with the Vazirmatn font.",
    "Switch preview size: desktop, tablet, mobile — responsive check built in.",
    "Every message keeps the project alive — files persist across turns.",
    "Chat and Agent share history — ask about code in either mode.",
    "Pick a custom model below the chat box — your provider, your keys.",
  ];

  const chatTips = CHAT_TIPS;

  function typewriter(el, text, speed = 38) {
    el.textContent = "";
    let i = 0;
    clearTimeout(el._pfTypeTimer);
    const step = () => {
      el.textContent = text.slice(0, i);
      if (i < text.length) {
        i++;
        el._pfTypeTimer = setTimeout(step, speed);
      }
    };
    step();
  }

  function startRotation(el, tips, intervalMs = 20000) {
    if (!el) return;
    // clear any previous rotation bound to this element (old hero nodes)
    if (el._pfTimer) clearInterval(el._pfTimer);
    if (el._pfTypeTimer) clearTimeout(el._pfTypeTimer);
    let idx = Math.floor(Math.random() * tips.length);
    const show = () => {
      typewriter(el, tips[idx % tips.length]);
      idx++;
    };
    show();
    el._pfTimer = setInterval(show, intervalMs);
  }

  function start() {
    startRotation(document.getElementById("heroTip"), chatTips, 20000);
    startRotation(document.getElementById("peTip"), AGENT_TIPS, 14000);
  }

  document.addEventListener("DOMContentLoaded", start);

  return { chatTips, AGENT_TIPS, startRotation };
})();
