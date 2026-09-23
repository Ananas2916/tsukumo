# Desk Companion

Un assistente 3D che vive sulla tua scrivania: carica un avatar **VRM**, parla
con **Kokoro TTS** in locale e muove la bocca in sincronia con l'audio.
Di default gira **tutto offline** sulla tua macchina, senza chiamate a servizi
esterni — e se vuoi puoi collegarlo a un servizio in rete, ma è una scelta
esplicita, mai il default.

Puoi parlargli a voce (push-to-talk, ascolto continuo o a chiamata) e scegliere
dal pannello quale cervello, quale voce e quale ascolto usare fra quelli
supportati: **11 motori di conversazione, 7 di sintesi vocale, 5 di
riconoscimento**.

> *A 3D desk companion with a VRM avatar, local text-to-speech, lip-sync and
> voice input. Runs fully offline by default; 11 LLM backends, 7 TTS engines
> and 5 speech-recognition engines are selectable from the panel.
> Documentation is in Italian — the code and configuration keys are in English.*

```
                    WebSocket (JSON + WAV base64)
  ┌────────────────┐  ─────────────────────────►  ┌──────────────────────┐
  │  Backend       │                               │  Frontend            │
  │  Python        │   { type: "speech",           │  Three.js +          │
  │                │     audio: "<wav b64>",       │  @pixiv/three-vrm    │
  │  LLM (Ollama)  │     visemes: [{t,d,v,w}] }    │                      │
  │  Kokoro TTS    │                               │  WebAudio + lip-sync │
  │  Visemi        │  ◄─────────────────────────   │  fcl_mth_a/i/u/e/o   │
  └────────────────┘     { type: "chat", ... }     └──────────────────────┘
```

---

## Indice

1. [Requisiti](#requisiti)
2. [Installazione rapida](#installazione-rapida)
3. [Installazione passo per passo](#installazione-passo-per-passo)
4. [L'avatar VRM](#lavatar-vrm)
5. [Avvio](#avvio)
6. [Configurazione](#configurazione)
7. [Come funziona il lip-sync](#come-funziona-il-lip-sync)
8. [Protocollo WebSocket e API REST](#protocollo-websocket-e-api-rest)
9. [Struttura del progetto](#struttura-del-progetto)
10. [Risoluzione dei problemi](#risoluzione-dei-problemi)

---

## Requisiti

| Componente | Versione | Note |
|------------|----------|------|
| Python | 3.10+ | testato su 3.11 |
| Node.js | 18+ | serve solo per compilare il frontend |
| Ollama **o** LM Studio | opzionale | per l'LLM locale; senza nessuno dei due, si usa il risponditore offline |
| Disco | ~800 MB | 350 MB di pesi Kokoro + ONNX Runtime + node_modules |

Non serve installare `espeak-ng` a parte: `kokoro-onnx` porta con sé
`espeakng-loader`, che include i dati di fonetizzazione anche su Windows.

---

## Installazione rapida

**Windows (PowerShell)**

```powershell
cd desk-companion
.\start.ps1 -Setup      # venv + pip + pesi Kokoro + npm install + build
.\start.ps1             # avvia tutto su http://127.0.0.1:8770
```

**macOS / Linux**

```bash
cd desk-companion
./start.sh --setup
./start.sh
```

Prima di avviare, copia un file `.vrm` in `frontend/public/models/avatar.vrm`
(vedi [L'avatar VRM](#lavatar-vrm)).

---

## Installazione passo per passo

Se preferisci sapere esattamente cosa succede, ecco gli stessi comandi
scomposti.

### 1. Dipendenze Python

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1        # Windows
# source .venv/bin/activate         # macOS / Linux

pip install --upgrade pip
pip install -r requirements.txt
```

### 2. Pesi di Kokoro TTS

```bash
python scripts/download_models.py
```

Scarica in `models/`:

| File | Dimensione | Contenuto |
|------|-----------|-----------|
| `kokoro-v1.0.onnx` | ~326 MB | il modello di sintesi |
| `voices-v1.0.bin` | ~27 MB | gli embedding di tutte le voci |

Varianti più leggere (utili su CPU lente):

```bash
python scripts/download_models.py --variant fp16   # ~169 MB
python scripts/download_models.py --variant int8   # ~92 MB
```

Il download riprende da dove si era interrotto se la connessione cade.
Puoi anche scaricare i file a mano dalla
[release `model-files-v1.0`](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0)
e metterli in `models/`.

### 3. Frontend

```bash
cd frontend
npm install
npm run build          # produce frontend/dist, servito dal backend
cd ..
```

### 4. LLM locale (opzionale ma consigliato)

Il backend parla con **qualunque** motore locale tu preferisca — bastano due
righe in `.env`.

**Ollama:**

```bash
ollama serve           # se non è già attivo come servizio
ollama pull llama3.2   # ~2 GB; va bene qualsiasi modello di chat
```

```env
DC_LLM_BACKEND=ollama
DC_OLLAMA_MODEL=llama3.2
```

**LM Studio** (o qualunque altro server con API stile OpenAI: llama.cpp
`server`, vLLM, text-generation-webui, ...): apri LM Studio, carica un
modello, poi tab **Developer → Start Server** (di default sulla porta 1234).

```env
DC_LLM_BACKEND=openai
DC_OPENAI_BASE_URL=http://127.0.0.1:1234/v1
DC_OPENAI_MODEL=auto
```

`DC_OPENAI_MODEL=auto` usa il primo modello che il server ha già caricato,
quindi di solito non serve toccarlo nemmeno quando cambi modello in LM Studio.

**OpenClaw** (se hai già [OpenClaw](https://openclaw.ai) configurato): il
companion diventa la voce e la faccia del tuo agente vero — stessa
personalità, stessa memoria persistente, stessi tool — invece di un chatbot
generico a parte. Non serve altro che il Gateway acceso:

```env
DC_LLM_BACKEND=openclaw
DC_OPENCLAW_AGENT_ID=companion
```

**Un agente dedicato, non `main`.** Il prompt di sistema di un agente con
profilo tool `full` contiene le definizioni di *tutti* i suoi tool e l'elenco
di tutte le sue skill: a ogni "ciao" sono migliaia di token da rileggere, e su
un modello locale piccolo vuol dire decine di secondi di attesa (misurati:
12.600 token e ~60 s contro 5.700 token e ~15 s). Conviene quindi un agente
`companion` che condivide **lo stesso workspace di `main`** (quindi stessa
personalità, stessi file di memoria) ma con pochi tool e nessuna skill di
troppo, in `~/.openclaw/openclaw.json`:

```json5
{ agents: { entries: { companion: {
  workspace: "C:\\Users\\<tu>\\.openclaw\\workspace",
  agentDir: "C:\\Users\\<tu>\\.openclaw\\agents\\companion\\agent",
  thinkingDefault: "off",
  skills: ["weather"],
  tools: { profile: "minimal", alsoAllow: ["group:web", "group:memory", "cron"] },
} } } }
```

Con `group:web` risponde alle domande sui fatti cercando davvero in rete
invece di inventare, che è il difetto principale dei modelli locali piccoli.

Il token si legge da solo da `~/.openclaw/openclaw.json`; imposta
`DC_OPENCLAW_TOKEN` solo per sovrascriverlo. Il companion crea **una sessione
dedicata e persistente** (salvata in `state/openclaw_session.json`, riusata
tra i riavvii) invece di scrivere nella tua conversazione principale, ma
tramite lo stesso agente eredita comunque la sua personalità e la sua
memoria di lungo periodo. Se quell'agente ha tool con effetti reali (browser,
file, GitHub, ...) il companion può davvero usarli in risposta a quello che
gli dici — non è un dettaglio da sottovalutare se lo usi mentre chiacchieri a
ruota libera.

Una limitazione pratica: a differenza di Ollama/LM Studio, OpenClaw non fa
streaming token-per-token di default — la risposta arriva tutta insieme a
fine elaborazione, quindi il companion inizia a parlare un po' più tardi
(niente "parte a metà frase" come con gli altri due backend). Si può
migliorare abilitando il *block streaming* lato OpenClaw
(`agents.defaults.blockStreamingDefault`), non ancora necessario di default.

Senza nessuno dei tre, il backend risponde comunque usando il risponditore
offline integrato (`DC_LLM_BACKEND=mock`, oppure automaticamente come
fallback se il motore configurato non risponde).

> **Modelli "reasoning" (minicpm, deepseek-r1, qwq, ...) e agenti che
> "pensano" (OpenClaw):** questi modelli mandano il ragionamento interno su
> un canale separato prima della risposta vera. I client `openai` e
> `openclaw` lo scartano sempre — verificato mandando messaggi veri a
> entrambi durante lo sviluppo — quindi il companion pronuncia solo la
> risposta finale e mai il "pensiero ad alta voce" del modello.

### 5. Finestra desktop (opzionale)

```bash
cd electron
npm install
cd ..
```

---

## L'avatar VRM

Il progetto **non include** un modello 3D: i VRM hanno licenze proprie e
pesano decine di MB. Devi procurartene uno.

1. Crea un personaggio gratis con **[VRoid Studio](https://vroid.com/en/studio)**
   ed esportalo in `.vrm`, oppure scaricane uno da **VRoid Hub** / **Booth**
   (controlla sempre la licenza d'uso).
2. Copialo in:

   ```
   frontend/public/models/avatar.vrm
   ```

3. Se il file ha un altro nome va bene lo stesso: il backend prende il primo
   `.vrm` che trova nella cartella. In alternativa **trascina il file
   direttamente sulla finestra** dell'applicazione.

### Blendshape richieste per il lip-sync

| Viseme | VRM 0.x (morph target) | VRM 1.0 (expression) |
|--------|------------------------|----------------------|
| A | `fcl_mth_a` | `aa` |
| I | `fcl_mth_i` | `ih` |
| U | `fcl_mth_u` | `ou` |
| E | `fcl_mth_e` | `ee` |
| O | `fcl_mth_o` | `oh` |

Il renderer preferisce le espressioni preset quando ci sono e altrimenti
scrive direttamente sui morph target, confrontando i nomi **senza distinguere
maiuscole e minuscole** (i VRoid recenti esportano `Fcl_MTH_A`, i più vecchi
`fcl_mth_a`). Tutti i modelli VRoid hanno almeno uno dei due. Il campo
`driver` nel pannello **Debug** mostra quale percorso è attivo.

---

## Avvio

### Modalità normale — tutto da un processo

```powershell
.\start.ps1
```

oppure, a mano:

```bash
python -m backend
```

Poi apri <http://127.0.0.1:8770>. Il backend serve anche il frontend
compilato, quindi non serve altro.

### Modalità sviluppo — hot reload del frontend

```powershell
.\start.ps1 -Dev
```

oppure, in due terminali:

```bash
python -m backend --reload          # terminale 1
cd frontend && npm run dev          # terminale 2 -> http://localhost:5173
```

Vite inoltra `/api` e `/ws` al backend, quindi funziona tutto anche da 5173.

### Dal desktop, senza terminale

```powershell
.\start.ps1 -Shortcut
```

Crea sul desktop il collegamento **Desk Companion**: doppio click e parte
tutto (Electron + backend), senza finestre nere e senza terminale. Dietro c'è
`Desk Companion.vbs` nella cartella del progetto, che si può anche mettere in
`shell:startup` per averla a ogni accesso. Tutto quello che stampa finisce in
`logs\companion.log`: è la prima cosa da guardare se non parte.

### Modalità desktop — finestra senza cornice

```powershell
.\start.ps1 -Electron
```

oppure:

```bash
cd electron && npm start
```

Electron avvia da solo il backend Python (usa il `.venv` del progetto se
c'è), poi apre due finestre:

- **il personaggio**: trasparente, senza bordi, sempre davanti a tutto;
- **il pannello**: chat e impostazioni, staccato dal personaggio. Di default
  sta agganciato al suo fianco e la segue; trascinandolo dalla barra del
  titolo si stacca e resta dove lo metti (il pulsante con la catena lo
  riaggancia, quello con la puntina lo tiene in primo piano).

Nell'area di notifica c'è un'icona sempre raggiungibile: apre chat e
impostazioni, attiva la modalità fantasma, chiude tutto. Serve soprattutto in
modalità fantasma, quando i click attraversano il personaggio.

Se il backend è già avviato a parte, usa `npm run start:attach`.

### Controlli dell'interfaccia

L'interfaccia è volutamente quasi invisibile, come una mascotte da scrivania:
normalmente si vede **solo il personaggio**. Tutto il resto compare quando
serve.

| Azione | Effetto |
|--------|---------|
| **tasto destro** sul personaggio | apre il pannello sulle impostazioni (voce, lingua, dimensione, comportamenti, modello 3D) |
| **doppio click** sul personaggio | apre il pannello sulla chat |
| inizia a digitare | apre la chat e ci scrive dentro |
| `Invio` / `Maiusc+Invio` | manda il messaggio / va a capo |
| `Esc` | chiude il pannello, oppure interrompe la voce |
| trascina un `.vrm` | carica un altro modello al volo |
| **rotellina** sul personaggio | la ingrandisce o rimpicciolisce (nel browser: zoom della camera) |

Nel browser (senza Electron) il pannello non c'è: tasto destro e doppio click
aprono il menu e la casella dentro la pagina.

Le due **spie di stato** (backend e OpenClaw) stanno in alto a sinistra: si
mostrano da sole quando qualcosa cambia e poi svaniscono, ma restano fisse se
c'è un problema. Passandoci sopra il mouse ricompaiono, e il tooltip dice cosa
non va.

### Comportamento da mascotte (solo Electron)

| Cosa | Come funziona |
|------|---------------|
| **Click-through per pixel** | il mouse attraversa la finestra ovunque tranne dove c'è davvero disegnato il personaggio — persino fra le gambe i click passano |
| **Presa per la collottola** | prendila col mouse: la solleva per il colletto (la collottola scivola sotto il cursore, qualunque punto tu abbia afferrato), penzola con le spalle alzate, gira piano su se stessa, oscilla se la muovi e scalcia se la scuoti |
| **Gravità** | se la lasci a mezz'aria cade agitando le braccia, e atterra piegando le ginocchia |
| **Finestre** | se la lasci sopra una finestra si siede sul suo bordo con le gambe che dondolano davanti, e viaggia con lei quando la sposti; se la finestra si chiude, si riduce a icona o si massimizza, cade |
| **Barra delle applicazioni** | ci sta in piedi, e ogni tanto si siede sul bordo, si sdraia a pancia in giù col mento fra le mani, o si distende sul fianco per il lungo (in quel caso la finestra si allarga da sola, perché il corpo diventa orizzontale) |
| **Musica** | se Spotify sta suonando si muove a tempo: vedi [Ballare con Spotify](#ballare-con-spotify) |
| **Bordi dello schermo** | lasciata oltre il bordo sinistro o destro, si aggrappa e sbircia dentro |
| **Dimensione** | con la rotellina (o dal pannello) si ingrandisce tutta la finestra: resta intera e con i piedi dove stavano |
| **Tocco** | un click sulla testa è una carezza (si rannicchia contento), sul corpo un colpetto (sobbalza) |
| **Sguardo** | segue il cursore ovunque sullo schermo, anche fuori dalla finestra; col mouse fermo guarda te |
| **Sempre in primo piano** | attivo di default; viene riaffermato ogni secondo, perché Windows riordina le finestre "in primo piano" ogni volta che una di loro (barra compresa) si attiva |
| **Modalità fantasma** | i click passano attraverso *tutto*, personaggio compreso |

Il click-through funziona leggendo l'alpha del pixel sotto il cursore
direttamente dal framebuffer WebGL. La posizione del cursore arriva dal
processo Electron, non dagli eventi del DOM: mentre la finestra è in
click-through la pagina non riceve eventi mouse, e senza quel canale si
creerebbe un circolo vizioso — la finestra resterebbe trasparente ai click per
sempre, incapace di accorgersi che il cursore è tornato sul personaggio.

Le finestre degli altri programmi si leggono direttamente da Windows
(`user32`/`dwmapi`) con [koffi](https://koffi.dev), una FFI con binari
precompilati: niente da compilare. Il codice è in `electron/desktop.js`,
la fisica (cadute, bordi, finestre) in `electron/pet-physics.js`. Su macOS e
Linux restano pavimento e bordi dello schermo.

Scala, primo piano e aggancio del pannello si salvano in `pet-settings.json`
nella cartella dati di Electron (`%APPDATA%/desk-companion-shell` su Windows).

Variabili utili per il debug: `DC_PET_DEBUG=1` scrive nel terminale cosa vede
il renderer (cursore, alpha, stato della finestra), `DC_PET_WIDTH` /
`DC_PET_HEIGHT` cambiano la dimensione di base della finestra.

### Le animazioni del corpo

Tutto il movimento è procedurale (`frontend/src/body.js`), senza clip di
animazione, ispirato a come si muovono i personaggi di Desktop Mate:

| Quando | Cosa fa |
|--------|---------|
| **Fermo** | peso su una gamba che ogni tanto passa all'altra, bacino e spalle che compensano, ginocchia morbide, piedi piantati (IK sulle gambe), respiro, braccia che pendono per gravità, dita rilassate |
| **Ogni tanto, da solo** | si stiracchia, si guarda intorno, si sistema i capelli, mette le mani dietro la schiena, canticchia, inclina la testa |
| **Mentre pensa** | mano al mento, l'altra a sostenere il gomito, occhi in alto |
| **Mentre parla** | annuisce a tempo con la voce, gesticola (palmi aperti, mano che spiega, mano sul cuore), alza le spalle alle domande |
| **All'avvio** | saluta con la mano |

Le emoji nelle risposte non vengono lette: diventano l'espressione del viso
mentre pronuncia quella frase (😊 sorride, 😢 si rattrista, 😮 si stupisce...).

Dalla console del browser si può far partire un'azione a mano, per esempio
`deskCompanion.stage.body.play('stretch')` (le altre: `lookAround`,
`hairTuck`, `handsBehind`, `hum`, `headTilt`, `wave`, `pat`, `flinch`).

### Ballare con Spotify

Quando l'app desktop di Spotify sta suonando, il personaggio si muove a tempo:
annuisce sul battito, sposta il peso da una gamba all'altra ogni due battiti,
molleggia sulle spalle. Il pannello mostra cosa sta suonando e l'interruttore
**Balla con la musica di Spotify** spegne tutto.

Funziona senza login, senza account sviluppatore e senza API di Spotify:

1. **cosa suona**: `electron/spotify.js` legge il titolo della finestra di
   `Spotify.exe` — "Artista - Titolo" mentre suona, "Spotify" in pausa;
2. **a che ritmo**: le API web con BPM ed "energy" delle tracce non sono più
   disponibili per le app nuove, quindi il tempo si ricava dall'audio vero.
   Electron cattura l'audio di sistema (loopback) e
   `frontend/src/music.js` ne calcola attacchi, tempo e fase del battito
   (flusso spettrale con i bassi pesati di più, autocorrelazione fra 70 e 180
   BPM, fase riallineata ogni mezzo secondo).

Se il tempo non è riconoscibile (musica d'atmosfera, podcast) non annuisce
fuori tempo: ondeggia piano. Mentre parla o pensa smette di ballare, e
l'ascolto dell'audio si accende solo quando Spotify suona davvero.

---

## Configurazione

Copia `.env.example` in `.env` e modifica quello che ti serve; in alternativa
usa direttamente le variabili d'ambiente (hanno la precedenza sul file).

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `DC_HOST` / `DC_PORT` | `127.0.0.1` / `8770` | indirizzo del backend |
| `DC_LLM_BACKEND` | `ollama` | `ollama`, `openai` (LM Studio e affini) oppure `mock` |
| `DC_OLLAMA_URL` | `http://127.0.0.1:11434` | endpoint di Ollama |
| `DC_OLLAMA_MODEL` | `llama3.2` | modello da usare con Ollama |
| `DC_OPENAI_BASE_URL` | `http://127.0.0.1:1234/v1` | endpoint stile OpenAI (default di LM Studio) |
| `DC_OPENAI_MODEL` | `auto` | modello da usare, o `auto` per il primo caricato |
| `DC_OPENAI_API_KEY` | *(vuoto)* | quasi mai necessaria per un server locale |
| `DC_OPENCLAW_AGENT_ID` | `main` | quale agente OpenClaw "diventa" il companion (meglio un agente dedicato: vedi sopra) |
| `DC_OPENCLAW_TOKEN` | *(vuoto)* | letto da `~/.openclaw/openclaw.json` se vuoto |
| `DC_LLM_FALLBACK` | `1` | se l'LLM non risponde, usa il mock |
| `DC_SYSTEM_PROMPT` | vedi `config.py` | personalità del companion |
| `DC_HISTORY_TURNS` | `12` | turni di conversazione ricordati |
| `DC_TTS_ENGINE` | `kokoro` | `kokoro`, `kokoro_http` o `formant` |
| `DC_VOICE` | `af_heart` | voce Kokoro |
| `DC_SPEED` | `1.0` | velocità di lettura |
| `DC_LANGUAGE` | `en-us` | pronuncia di riserva, se il nome della voce non dice la lingua |
| `DC_REPLY_LANGUAGE` | `auto` | `auto` (lingua della voce), `same` (lingua in cui scrivi) o una lingua (`English`, `it`...) |
| `DC_TTS_FALLBACK` | `1` | se Kokoro non parte, usa la voce di servizio |
| `DC_OPENCLAW_ENABLED` | `1` | mostra la spia del Gateway OpenClaw |
| `DC_OPENCLAW_URL` | `http://127.0.0.1:18789` | Gateway da sondare |
| `DC_OPENCLAW_INTERVAL` | `5` | secondi fra un controllo e l'altro |
| `DC_VISEME_GAIN` | `1.15` | quanto si apre la bocca |
| `DC_VISEME_SILENCE` | `0.07` | soglia di silenzio (0–1) |
| `DC_KOKORO_MODEL` | `models/kokoro-v1.0.onnx` | percorso del modello |
| `DC_KOKORO_VOICES` | `models/voices-v1.0.bin` | percorso delle voci |
| `DC_KOKORO_HTTP_URL` | `http://127.0.0.1:8880` | server Kokoro-FastAPI |

### Lingua: la voce decide tutto

Una voce inglese che legge una risposta in italiano la pronuncia con le regole
sbagliate, ed è incomprensibile. Per questo la **lingua delle risposte segue la
voce**: il nome delle voci Kokoro la dice già con la prima lettera (`a`/`b`
inglese, `i` italiano, `f` francese, `e` spagnolo, `j` giapponese, `p`
portoghese, `z` cinese). Con `af_heart` risponde sempre in inglese anche se le
scrivi in italiano; scegliendo `if_sara` o `im_nicola` passa tutto
all'italiano, pronuncia compresa.

A ogni turno il backend aggiunge all'LLM un'istruzione esplicita ("rispondi
sempre in inglese, testo semplice, niente emoji"). Con OpenClaw, che ha una
personalità sua e non riceve il nostro system prompt, l'istruzione viaggia
davanti al messaggio: senza, l'agente risponderebbe nella lingua in cui scrivi.

Voce e lingua si cambiano al volo dal pannello; da `.env`:

```env
DC_VOICE=if_sara
# auto = lingua della voce (default), same = lingua in cui scrivi, oppure una lingua
DC_REPLY_LANGUAGE=auto
```

L'elenco completo delle voci disponibili è in `GET /api/voices` e nella
tendina del pannello, raggruppato per lingua.

### La spia di OpenClaw

Sotto il badge di stato, in alto a sinistra, c'è una seconda pillola che dice
se il [Gateway OpenClaw](https://openclaw.ai) è raggiungibile:

| Colore | Stato | Significato |
|--------|-------|-------------|
| 🟢 verde | `online` | il Gateway risponde e si dichiara pronto |
| 🟡 giallo | `degraded` | risponde, ma `/readyz` segnala qualcosa che non va (es. un canale che non parte) |
| 🔴 rosso | `offline` | il Gateway non è in ascolto |
| ⚪ grigio | `unknown` | il backend del companion non è raggiungibile, quindi non lo sappiamo |

Il backend interroga le probe **non autenticate** del Gateway — `GET /health`
per la liveness e `GET /readyz` per la readiness — ogni 5 secondi, e manda un
messaggio WebSocket `{"type": "openclaw", ...}` **solo quando lo stato
cambia**. Passando il mouse sulla pillola compaiono URL, versione del Gateway
e il motivo dell'eventuale problema.

Non serve nessun token: quelle due probe sono pubbliche per progetto. Se il tuo
Gateway è su un'altra porta, cambia `DC_OPENCLAW_URL`; con
`DC_OPENCLAW_ENABLED=0` la pillola sparisce.

Per uno snapshot da riga di comando:

```bash
curl http://127.0.0.1:8770/api/openclaw
```

### I tre motori TTS

| `DC_TTS_ENGINE` | Cosa usa | Quando serve |
|-----------------|----------|--------------|
| `kokoro` | `kokoro-onnx` in-process | **default**, tutto locale |
| `kokoro_http` | un server [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) già avviato | se lo hai già, magari con GPU |
| `formant` | sintetizzatore di vocali integrato | provare la catena senza scaricare i pesi |

`formant` non è una voce realistica: genera le formanti corrette di A/E/I/O/U,
quindi è perfetto per verificare che il lip-sync funzioni, ma non per
ascoltare davvero le risposte.

---

## Come funziona il lip-sync

Il codice è in `backend/visemes.py` e `backend/phonemes.py`, e ha due percorsi.

**Percorso A — tempi esatti.** Alcune build del modello Kokoro espongono
l'output delle durate: in quel caso `create_timed()` dice esattamente quando
inizia e finisce ogni fonema, e basta tradurre i simboli IPA in visemi. Il
backend lo tenta sempre per primo e lo segnala nel log
(`… – 27 visemi [timing esatti]`).

**Percorso B — allineamento sull'energia.** I pesi `v1.0` pubblicati non
includono quell'output, quindi in pratica gira quasi sempre questo, in quattro
passaggi.

**1. Fonemi.** `kokoro-onnx` porta con sé espeak-ng, quindi prendiamo la
trascrizione IPA reale della frase — `"Hello there, how are you today?"` →
`həlˈoʊ ðˈɛɹ, hˌaʊ ɑːɹ juː tədˈeɪ?`. Se espeak non fosse disponibile si usa un
G2P euristico interno (digrammi, doppie, cifre). Ogni fonema viene ridotto a
tre numeri: quale dei cinque visemi attivare, quanto dura in proporzione e
quanto apre la bocca — `ɑ` apre molto, `ə` poco, `p`/`b`/`m` la chiudono del
tutto.

**2. Energia dell'audio.** Calcoliamo l'inviluppo RMS con finestre da 25 ms e
hop da 10 ms (somma cumulativa dei quadrati, quindi O(n)), normalizzato sul
95° percentile per non farci ingannare dai picchi isolati.

**3. Allineamento.** I tratti sopra soglia diventano *segmenti di parlato*; i
micro-silenzi sotto i 90 ms vengono assorbiti. I fonemi sono poi distribuiti
sul tempo di parlato *complessivo*, proporzionalmente alla loro durata
relativa, e rimappati sul tempo reale. Le pause della frase finiscono così
automaticamente nei silenzi veri dell'audio, e un fonema a cavallo di una
pausa viene spezzato. L'apertura di ogni viseme viene moltiplicata per
l'energia media del tratto corrispondente.

**4. In tempo reale, nel browser** (comune a entrambi i percorsi). Il frontend riceve la timeline
`[{t, d, v, w}, ...]` insieme al WAV. A ogni frame:

```
peso_finale = peso_timeline × (0.45 + 0.55 × rms_istantaneo) × guadagno
```

Il termine RMS arriva da un `AnalyserNode` di WebAudio, cioè dall'audio che sta
davvero suonando in quel momento: anche se la timeline sbanda di qualche decina
di millisecondi, la bocca resta agganciata al volume percepito. I pesi passano
poi per uno smoothing esponenziale asimmetrico (apertura rapida, chiusura più
morbida) e per una dissolvenza di 50 ms verso il viseme successivo, che
simula la coarticolazione.

Se la timeline mancasse del tutto, il sistema degrada elegantemente: la bocca
si muove sulla sola ampiezza, come un lip-sync "a volume".

---

## Protocollo WebSocket e API REST

### WebSocket `ws://127.0.0.1:8770/ws`

**Client → server**

```jsonc
{ "type": "chat",   "text": "ciao, come va?" }   // LLM + voce
{ "type": "say",    "text": "buongiorno" }        // solo voce
{ "type": "settings", "voice": "if_sara", "replyLanguage": "auto" }  // voce e lingua, a caldo
{ "type": "cancel" }                              // interrompe il turno
{ "type": "reset" }                               // svuota la conversazione
{ "type": "ping" }
```

**Server → client**

```jsonc
{ "type": "hello",  "version": "1.0.0", "config": {...}, "voices": [...],
                    "blendshapes": {...}, "avatar": {...} }
{ "type": "state",  "value": "thinking" | "speaking" | "idle" }
{ "type": "token",  "text": "frammento " }        // streaming dell'LLM
{ "type": "speech", "text": "Ciao!", "format": "wav", "sampleRate": 24000,
                    "duration": 1.42, "audio": "<wav in base64>",
                    "visemes": [ { "t": 0.08, "d": 0.11, "v": "a", "w": 0.73 } ],
                    "mood": "happy" }             // umore dalle emoji tolte, o null
{ "type": "settings", "voice": "...", "replyLanguage": "auto", "replyLanguageResolved": "English" }
{ "type": "reply",  "text": "risposta completa", "elapsed": 2.31 }
{ "type": "openclaw", "state": "online" | "degraded" | "offline",
                    "connected": true, "url": "...", "version": "...", "error": null }
{ "type": "notice" | "error", "message": "..." }
{ "type": "pong" }
```

Nella timeline: `t` = istante di inizio in secondi, `d` = durata, `v` = viseme
(`a`/`i`/`u`/`e`/`o`/`sil`), `w` = peso 0–1.

I messaggi sono inviati in **broadcast** a tutti i client collegati: se apri
due finestre, entrambe mostrano lo stesso avatar parlare.

### REST

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| `GET` | `/api/health` | stato di TTS, LLM e avatar |
| `GET` | `/api/config` | configurazione pubblica e mappa delle blendshape |
| `GET` | `/api/voices` | voci disponibili |
| `GET` | `/api/openclaw` | stato del Gateway OpenClaw (forza un controllo) |
| `POST` | `/api/say` | sintetizza un testo (l'audio va ai client WS) |
| `POST` | `/api/chat` | turno completo con l'LLM |
| `POST` | `/api/cancel` | interrompe |
| `POST` | `/api/reset` | azzera la conversazione |

Esempio con `curl` — l'avatar aperto nel browser parlerà:

```bash
curl -X POST http://127.0.0.1:8770/api/say \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"Hello from the terminal!\"}"
```

La risposta contiene la timeline dei visemi (senza il blob audio, per restare
leggibile), quindi è anche un buon modo per ispezionare il lip-sync.

La documentazione interattiva generata da FastAPI è su
<http://127.0.0.1:8770/docs>.

---

## Struttura del progetto

```
desk-companion/
├── backend/
│   ├── __main__.py        # python -m backend
│   ├── server.py          # FastAPI: WebSocket, REST, file statici
│   ├── pipeline.py        # LLM -> frasi -> TTS -> visemi -> broadcast
│   ├── config.py          # impostazioni da env / .env
│   ├── audio.py           # WAV, base64, inviluppo RMS
│   ├── openclaw.py        # spia verde/rossa del Gateway OpenClaw
│   ├── phonemes.py        # IPA e G2P -> visemi (fcl_mth_*)
│   ├── visemes.py         # allineamento fonemi <-> energia dell'audio
│   ├── llm/               # ollama.py, openai_compatible.py (LM Studio...), openclaw.py, mock.py
│   └── tts/               # kokoro_engine.py, kokoro_http.py, formant.py
├── frontend/
│   ├── index.html
│   └── src/
│       ├── main.js        # collega tutti i pezzi
│       ├── vrm.js         # Three.js + three-vrm, sguardo, blink, blendshape
│       ├── body.js        # animazione del corpo: postura, IK, gesti, reazioni
│       ├── panel.js       # pannello Electron: chat e impostazioni
│       ├── lipsync.js     # timeline + RMS -> pesi della bocca
│       ├── audio.js       # coda WebAudio + misura RMS
│       ├── ws.js          # WebSocket con riconnessione
│       ├── ui.js          # DOM
│       └── style.css
├── electron/
│   ├── main.js            # finestre (personaggio + pannello), icona, IPC
│   ├── pet-physics.js     # cadute, barra, bordi, finestre su cui sedersi
│   ├── desktop.js         # finestre degli altri programmi (Windows, via koffi)
│   └── preload.js
├── scripts/
│   └── download_models.py # pesi Kokoro, con ripresa del download
├── models/                # <- i pesi finiscono qui (non versionati)
├── requirements.txt
├── start.ps1 / start.sh
└── .env.example
```

---

## Risoluzione dei problemi

**«Backend non raggiungibile»**
Il server Python non è partito. Avvialo con `python -m backend` e guarda il
log: se dice `Motore TTS 'kokoro' non disponibile`, mancano i pesi.

**«Manca il modello 3D»**
Copia un `.vrm` in `frontend/public/models/avatar.vrm`, oppure trascinalo sulla
finestra. Verifica con `curl http://127.0.0.1:8770/api/health` che `avatar.files`
non sia vuoto.

**L'avatar si vede ma la bocca non si muove**
Apri il pannello **Debug**: se `driver` dice *nessuna blendshape bocca*, il
modello non ha né le espressioni `aa/ih/ou/ee/oh` né i morph `fcl_mth_*`.
Se invece `rms` resta a `0.00`, il problema è l'audio (vedi sotto).

**Non si sente nulla**
Nel browser l'audio resta bloccato finché non c'è un'interazione: clicca una
volta nella finestra (nella finestra Electron non serve, l'autoplay è
sbloccato). Controlla anche il volume di sistema e che `duration` nei messaggi
`speech` non sia `0`. Se hai modificato il frontend, ricordati di ricompilarlo
(`npm run build` in `frontend/`): il backend serve `frontend/dist`.

**«Pesi Kokoro non trovati»**
`python scripts/download_models.py`. Se il download si blocca, riprendilo: lo
script continua dal punto in cui si era fermato. Verifica poi che
`models/kokoro-v1.0.onnx` sia di ~326 MB e non un file HTML di errore.

**La prima frase arriva lenta**
Normale: ONNX Runtime carica il modello alla prima sintesi. Le successive sono
molto più rapide. Sulle CPU lente, `--variant int8` fa una bella differenza.

**Ollama risponde con markdown che viene letto ad alta voce**
Il backend toglie già `* _ ` # >` ed emoji/faccine (`:)`, `<3`...), ma la cosa
migliore è irrobustire `DC_SYSTEM_PROMPT`: «plain text only, no markdown».
Con OpenClaw il system prompt non passa (la personalità è quella dell'agente),
quindi lì conta solo la ripulitura lato backend.

**Errori ONNX Runtime all'avvio (`DLL load failed`, `onnxruntime` non importabile)**
Su Windows serve il
[Visual C++ Redistributable 2015-2022](https://aka.ms/vs/17/release/vc_redist.x64.exe).
Nel frattempo il backend continua a funzionare con `DC_TTS_ENGINE=formant`.

**La finestra Electron è tutta nera invece che trasparente**
Su alcune configurazioni Linux la trasparenza richiede un compositore attivo.
Attiva la casella **Sfondo** nell'interfaccia per avere uno sfondo opaco.

---

## Licenza

Desk Companion è distribuito sotto **GNU AGPL v3** (testo completo in
[`LICENSE`](LICENSE)). In breve, e senza valore legale:

- puoi **usarlo, studiarlo, modificarlo e ridistribuirlo** liberamente;
- se lo ridistribuisci, o se ne offri una versione modificata **come servizio
  di rete**, devi rendere disponibile il tuo codice sorgente con la stessa
  licenza;
- non c'è alcuna garanzia.

La clausola sul servizio di rete è il motivo della scelta: chiunque può
prendere questo progetto e farci quello che vuole, ma nessuno può chiuderlo in
un prodotto proprietario senza restituire le proprie modifiche.

### Parti di terzi

Hanno licenze proprie, da rispettare separatamente:

- **Kokoro** — modello TTS, Apache 2.0
- **three.js**, **@pixiv/three-vrm** — MIT
- **Electron**, **FastAPI**, **ONNX Runtime** — MIT / Apache 2.0
- **Il tuo modello VRM** — licenza dell'autore: se lo hai scaricato, controlla
  cosa permette (uso commerciale, modifiche, ridistribuzione).
