# Tsukumo

> *Nel folklore giapponese i **tsukumogami** sono oggetti che, dopo cent'anni,
> prendono un'anima e cominciano a muoversi. Questo fa lo stesso con la tua
> scrivania, ma senza aspettare tanto.*

> **Scarica e installa (Windows 10/11):** l'ultimo `Tsukumo Setup <versione>.exe`
> dalla pagina [Releases](https://github.com/Ananas2916/tsukumo/releases/latest).
> Non servono Python né Node: doppio click, avanti, fine. Windows SmartScreen
> la prima volta avvisa che l'app non è firmata: *Ulteriori informazioni →
> Esegui comunque*.

Un assistente 3D che vive sulla tua scrivania: carica un avatar **VRM**, parla
con **Kokoro TTS** in locale e muove la bocca in sincronia con l'audio.
Di default gira **tutto offline** sulla tua macchina, senza chiamate a servizi
esterni — e se vuoi puoi collegarlo a un servizio in rete, ma è una scelta
esplicita, mai il default.

Il cervello può essere un **agente vero** — Claude Code, Codex, OpenClaw,
Hermes Agent o qualunque programma da riga di comando — e Tsukumo ne diventa
la voce e la faccia, con la sua memoria e i suoi strumenti. Oppure un modello
locale (LM Studio, Ollama) o un servizio in rete. Le voci vanno da Kokoro in
locale a ElevenLabs, OpenAI, Azure, Google e Cartesia.

Puoi parlargli a voce (push-to-talk, ascolto continuo o a chiamata) e scegliere
dal pannello quale cervello, quale voce e quale ascolto usare: **15 cervelli
(5 agenti), 11 voci, 5 modi di ascolto**, ognuno con una verifica che dice
subito se funziona prima di attivarlo.

> *Tsukumo is a 3D desk companion with a VRM avatar, local text-to-speech,
> lip-sync and voice input. Its brain can be a real agent (Claude Code, Codex,
> OpenClaw, Hermes, any CLI agent), a local model or a cloud API; 15 brains,
> 11 voices and 5 speech-recognition engines are selectable from the panel.
> Named after the tsukumogami — objects that come alive in Japanese folklore.
> Documentation is in Italian; the code and configuration keys are in English.*

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
6. [L'assistente: promemoria, commenti, avvisi](#lassistente-promemoria-commenti-avvisi)
7. [Configurazione](#configurazione)
8. [Come funziona il lip-sync](#come-funziona-il-lip-sync)
9. [Protocollo WebSocket e API REST](#protocollo-websocket-e-api-rest)
10. [Struttura del progetto](#struttura-del-progetto)
11. [Risoluzione dei problemi](#risoluzione-dei-problemi)

---

## Requisiti

| Componente | Versione | Note |
|------------|----------|------|
| Python | 3.10+ | testato su 3.11 |
| Node.js | 18+ | serve solo per compilare il frontend |
| Un cervello | opzionale | un agente (Claude Code, Codex, OpenClaw, Hermes...), LM Studio/Ollama, o una chiave di un servizio in rete; per provare basta il risponditore offline |
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

**Costruire l'installer**

```powershell
.\scripts\build_installer.ps1     # -> electron\dist\Tsukumo Setup <versione>.exe
```

Crea un setup per Windows che porta con sé un Python embeddable con le
dipendenze già installate, il backend, l'interfaccia compilata, un avatar e
Kokoro (variante `int8`, 92 MB: con `-KokoroVariant full` quella da 326 MB).
Si installa per l'utente, senza diritti di amministratore; impostazioni,
stato, log e l'avatar scelto dell'app installata stanno in
`%APPDATA%\Tsukumo`, così un aggiornamento non li tocca. `-SkipInstaller` si
ferma a `electron\dist\win-unpacked`, da provare senza installare.

Di norma l'installer è **pubblico**: l'avatar è Sendagaya Shino, modello di
esempio di VRoid Studio rilasciato in CC0, non ci sono clip, e la build si
ferma se un avatar incluso non si può ridistribuire (lo controlla
`scripts/package_audit.py` leggendo la licenza scritta dentro il `.vrm`).
Accanto al programma finiscono `LICENSE` e `THIRD-PARTY-NOTICES.txt` con le
licenze di ogni componente. Con `-IncludeLocalAssets` entrano invece il tuo
avatar e le tue clip: il file si chiama `... (personale).exe` e non va
pubblicato.

Al primo avvio il pannello si apre con una presentazione in cinque passi: come
si usa, come ti chiami, il cervello (fra quelli trovati sul PC), la voce, e un
saluto. Si rifà da Personaggio → Altro.

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

### 4. Il cervello: un agente o un modello

Si sceglie dal pannello, scheda **Motori → Cervello**: ogni motore ha la sua
scheda con costo, requisiti, campi da compilare e un tasto **Verifica** che
prova la configurazione *prima* di attivarla. Le scelte finiscono in `.env`,
quindi si possono anche scrivere a mano.

**Al primo avvio sceglie da solo.** Poco dopo la partenza il backend cerca, in
background, i cervelli già presenti sul PC: Claude Code e Codex cercando il
programma (senza lanciarlo), OpenClaw, Ollama e LM Studio con una richiesta
HTTP da un secondo (`/health` del Gateway, `127.0.0.1:11434/api/tags`,
`127.0.0.1:1234/v1/models`). Nella scheda Motori quelli trovati hanno il badge
**Trovato sul PC**. Se `DC_LLM_BACKEND` non è scritto né nel `.env` né
nell'ambiente, Tsukumo usa il primo trovato in quest'ordine — `claude_code`,
`codex`, `openclaw`, `ollama`, `openai` — e lo salva nel `.env`; se uno non
parte (OpenClaw acceso ma senza token, per esempio) prova il successivo. Una
scelta esplicita non viene mai toccata. `DC_DETECT_ENGINES=0` spegne la
ricerca.

**Agenti.** Un agente ha memoria e strumenti propri: Tsukumo gli passa solo
l'ultimo messaggio (più le regole del parlato: lingua della voce, niente
markdown) e legge ad alta voce la sua risposta. La conversazione continua fra
un messaggio e l'altro e sopravvive ai riavvii (`state/*_session.json`).
"Nuova" nella chat la azzera.

| Agente | Come si collega | Costo |
|--------|-----------------|-------|
| **Claude Code** | lancia `claude -p` già autenticato; di default può solo cercare sul web e leggere file | il tuo abbonamento Claude |
| **Codex** | lancia `codex exec`; se non è nel PATH usa quello dell'estensione di VS Code | il tuo account ChatGPT |
| **OpenClaw** | il Gateway locale via WebSocket (vedi sotto) | quello del modello dietro |
| **Hermes Agent** | il suo API server compatibile OpenAI (`API_SERVER_ENABLED=true`, porta 8642) | gratis |
| **Altro agente** | qualunque comando: `{prompt}` diventa il messaggio, altrimenti va sullo standard input | — |

```env
DC_LLM_BACKEND=claude_code
DC_CLAUDE_CODE_MODEL=          # vuoto = quello del tuo account; haiku risponde prima
DC_CLAUDE_CODE_CWD=            # cartella che puo' leggere (vuoto = la tua cartella utente)
```

Per Claude Code e Codex il companion parte in modalità prudente: Claude Code
ha solo gli strumenti elencati in `DC_CLAUDE_CODE_TOOLS` (ricerca web e
lettura) e Codex gira con `-s read-only`. Si allargano dalle impostazioni
avanzate della loro scheda, sapendo che poi potranno modificare file.

**Modelli locali.** Il backend parla con **qualunque** motore locale tu
preferisca — bastano due righe in `.env`.

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

Se il cervello non risponde, nella chat compare una scheda d'errore con il
motivo ("Gateway OpenClaw spento", "chiave API non valida"...) e un tasto che
porta dritto alla scheda Motori. Il risponditore offline (`DC_LLM_BACKEND=mock`)
resta disponibile per provare voce e animazioni; come ripiego automatico va
acceso a mano (`DC_LLM_FALLBACK=1`), perché una risposta preconfezionata al
posto di un errore nasconde il problema.

> **Modelli "reasoning" (minicpm, deepseek-r1, qwq, ...) e agenti che
> "pensano":** questi modelli mandano il ragionamento interno su un canale
> separato prima della risposta vera. Tutti i client lo scartano sempre
> (`reasoning_content`, gli eventi `thinking` di OpenClaw, i `thinking_delta`
> di Claude Code, gli item `reasoning` di Codex), quindi il companion pronuncia
> solo la risposta finale e mai il "pensiero ad alta voce" del modello.

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

Crea sul desktop il collegamento **Tsukumo** (e toglie quello col vecchio nome
"Desk Companion"): doppio click e parte tutto (Electron + backend), senza
finestre nere e senza terminale. Dietro c'è `Tsukumo.vbs` nella cartella del
progetto, che si può anche mettere in `shell:startup` per averla a ogni
accesso.

Il personaggio compare subito con un biglietto "si sta svegliando…" mentre il
backend parte; se qualcosa va storto il biglietto dice cosa, con le ultime
righe del backend. Tutto finisce anche in `logs\companion.log` (icona
nell'area di notifica → **Apri il log**), qualunque sia il modo in cui l'hai
avviato. Se trova un backend di Tsukumo già acceso lo riusa; se sulla porta è
rimasto appeso un backend di un avvio precedente lo chiude; se una pagina non
si carica la riprova da solo invece di lasciare la finestra vuota.

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

Nell'area di notifica c'è un'icona sempre raggiungibile: apre chat,
personaggio e motori, mostra i comandi accanto a lei, attiva la modalità
fantasma, riavvia, apre il log, chiude tutto. Serve soprattutto in modalità
fantasma, quando i click attraversano il personaggio.

Se il backend è già avviato a parte, usa `npm run start:attach`.

### Controlli dell'interfaccia

L'interfaccia è volutamente quasi invisibile, come una mascotte da scrivania:
normalmente si vede **solo il personaggio**. Tutto il resto compare quando
serve.

| Azione | Effetto |
|--------|---------|
| **tasto destro** sul personaggio | apre (o chiude) i **dock** ai suoi lati |
| **doppio click** sul personaggio | apre il pannello sulla chat |
| inizia a digitare | apre la chat e ci scrive dentro |
| `Invio` / `Maiusc+Invio` | manda il messaggio / va a capo |
| `Esc` | chiude i dock o il pannello, oppure interrompe la voce |
| trascina un `.vrm` | carica un altro modello al volo |
| **rotellina** sul personaggio | la ingrandisce o rimpicciolisce (nel browser: zoom della camera) |

**I dock.** Due archi di vetro scuro ai lati del busto, che la seguono anche
seduta o sdraiata, e si richiudono da soli quando il cursore se ne va:

| A sinistra: lo stato | A destra: dove andare |
|----------------------|------------------------|
| **cervello** — verde se risponde, ambra che gira mentre pensa, rosso se è spento; clic = scheda Motori | **chat** |
| **voce** — l'anello si riempie col volume mentre parla; clic = voce spenta/accesa | **personaggio** — voce, aspetto, comportamento, azioni |
| **microfono** — livello mentre ti ascolta; clic = parla | **motori** — cervello, voce, ascolto |
| **musica** — batte a tempo con Spotify; clic = balla o no | **spegni** — secondo clic per confermare |

Passando sopra un bottone compare una didascalia con il dettaglio ("Claude
Code: pronto", "OpenClaw: spento — Gateway OpenClaw spento"...). Con la voce
spenta risponde solo per iscritto, e una voce a consumo non spende caratteri.

**Il pannello** ha tre schede. **Chat**, con le risposte in markdown, gli
errori spiegati in una scheda con il rimedio, il microfono e "fai solo
leggere"; in alto si vede sempre chi sta rispondendo. **Personaggio**, con il
selettore delle voci (ricerca, filtro per lingua, ascolto di prova: le
anteprime di ElevenLabs non costano caratteri), la lingua delle risposte,
dimensione, bocca, comportamenti e azioni. **Motori**, descritta sotto.

Nel browser (senza Electron) i dock ci sono lo stesso: la chat si apre dentro
la pagina, personaggio e motori in una finestra a parte.

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
| **Tocco** | un click sulla testa è una carezza (si rannicchia contento), sul corpo un colpetto (sobbalza); cinque colpetti in pochi secondi e mette il broncio, a braccia conserte |
| **Cursore** | se resta fermo sopra la sua testa allunga la mano per toccarlo, in punta di piedi; se glielo fai girare intorno alla testa, veloce, le gira la testa |
| **File** | trascina un file su di lei: lo prende e lo passa al cervello ("dai un'occhiata a questo file") |
| **Effetti sonori** | un "pop" quando compare, un tonfo quando atterra, un campanello e un toc-toc sul vetro per promemoria e avvisi; sintetizzati, fuori dal canale della voce |
| **Versetti** | con la voce scelta: "Ciao!" quando compare (o "Buongiorno!", "Buonasera!", "Ancora in piedi?" secondo l'ora), una risatina alle carezze, "Ehi!" a un colpetto o se la sollevi, "Aaah!" se la lanci |
| **Sonno** | se non tocchi mouse e tastiera per 2 minuti si fa assonnata (palpebre pesanti, colpi di sonno, qualche sbadiglio), dopo 5 si addormenta — sulla barra si stende sul fianco, con le "zeta" che salgono dalla testa. Quando torni, sblocchi lo schermo o il PC si risveglia, si alza e ti saluta |
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
nella cartella dati di Electron (`%APPDATA%\Tsukumo` su Windows). Al primo
avvio col nuovo nome le impostazioni, la chat e le preferenze di
`%APPDATA%\desk-companion-shell` vengono copiate lì da sole.

I **versetti** li sintetizza il backend (`POST /api/vocal`) con il motore e la
voce in uso, nella lingua della voce: una voce italiana dice "Ciao!", una
inglese "Hii!". Ogni frase si sintetizza una volta per voce e poi resta in
cache, quindi con una voce a pagamento costa pochi caratteri in tutto. Non
entrano nella conversazione, tacciono se il personaggio è muto o sta pensando o
parlando, e non partono a ogni click. Frasi e lingue sono in `backend/vocals.py`.

Il **sonno** usa `powerMonitor` di Electron: ogni 5 secondi il processo main
dice al personaggio da quanto il PC è fermo (`getSystemIdleTime`) e gli
inoltra blocco/sblocco dello schermo e sospensione/ripresa. Mentre parla,
pensa, balla o è in mano non si addormenta. La logica è in
`frontend/src/presence.js`. Versetti e sonno si spengono dal pannello, scheda
Personaggio → Comportamento.

Variabili utili per il debug: `DC_PET_DEBUG=1` scrive nel terminale cosa vede
il renderer (cursore, alpha, stato della finestra), `DC_PET_WIDTH` /
`DC_PET_HEIGHT` cambiano la dimensione di base della finestra.

### Le animazioni del corpo

Tutto il movimento è procedurale, senza clip di animazione, ispirato a come si
muovono i personaggi di Desktop Mate. `frontend/src/body.js` è l'animatore;
in `frontend/src/body/` ci sono i suoi mattoni: curve e molle (`motion.js`),
l'accumulatore della posa (`pose.js`), le azioni spontanee e i gesti del
parlato (`actions.js`), le costanti (`constants.js`).

| Quando | Cosa fa |
|--------|---------|
| **Fermo** | peso su una gamba che ogni tanto passa all'altra, bacino e spalle che compensano, ginocchia morbide, piedi piantati (IK sulle gambe), respiro, braccia che pendono per gravità, dita rilassate |
| **Ogni tanto, da solo** | si stiracchia, si guarda intorno, si sistema i capelli, mette le mani dietro la schiena, canticchia, inclina la testa |
| **Mentre pensa** | mano al mento, l'altra a sostenere il gomito, occhi in alto |
| **Mentre un agente lavora** | legge un tablet olografico (quando l'agente legge file o cerca) o batte su una tastiera olografica (quando scrive o esegue comandi), con il passo in corso nella bolla |
| **Mentre parla** | annuisce a tempo con la voce, gesticola (palmi aperti, mano che spiega, mano sul cuore), alza le spalle alle domande |
| **All'avvio** | saluta con la mano e con la voce ("Ciao!", o il saluto adatto all'ora) |
| **Se non usi il PC** | assonnata: palpebre pesanti, sguardo basso, la testa che cade piano e si rialza di scatto, qualche sbadiglio con la mano davanti alla bocca; addormentata: occhi chiusi, testa reclinata, respiro lento e profondo |
| **Per un promemoria o un avviso** | bussa sul vetro dello schermo verso di te |
| **Col caldo e col freddo** | si fa aria con la mano; si stringe le braccia e trema |

Oltre al movimento procedurale può usare **clip `.vrma`** (VRM Animation):
mettile in `frontend/public/animations/` e il nome dice quando usarle
(`greet*` al posto del saluto, `idle*` fra i gesti spontanei, `dance*` in loop
con Spotify, `inchino*` quando la ringrazi, `alza*` quando la chiami per nome,
le altre dai pulsanti del pannello). Si mescolano alla posa procedurale in
dissolvenza, solo nelle rotazioni delle ossa. Vedi il README della cartella e
`frontend/src/clips.js`.

**Da motion capture:** un BVH (Mixamo, CMU...) si converte con
`node scripts/bvh2vrma.mjs clip.bvh clip.vrma --trim`, che lo porta in T-pose
qualunque sia la sua posa di riposo e lo tiene rivolto verso di te. Scegli
riprese naturali: quelle recitate "con stile" (i dataset per la style
transfer) su una mascotte sembrano un balletto.

Le emoji nelle risposte non vengono lette: diventano l'espressione del viso
mentre pronuncia quella frase (😊 sorride, 😢 si rattrista, 😮 si stupisce...).

Dalla console del browser si può far partire un'azione a mano, per esempio
`deskCompanion.stage.body.play('stretch')` (le altre: `lookAround`,
`hairTuck`, `handsBehind`, `hum`, `headTilt`, `yawn`, `knock`, `fanSelf`,
`shiver`, `dizzy`, `pout`, `wave`, `pat`, `flinch`).
Il sonno si prova con `deskCompanion.stage.setSleep(0.5)` (assonnata) o `1`
(addormentata), un versetto con `deskCompanion.vocals.say('greet')`.

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

## L'assistente: promemoria, commenti, avvisi

Tsukumo non aspetta solo che le scrivi: tiene i tuoi promemoria, si accorge di
cosa stai facendo al PC e ogni tanto dice qualcosa di suo. Tutto si regola dal
pannello (schede **Agenda** e **Personaggio**).

### La lingua del sistema

Se nessuno ha scelto una voce (`DC_VOICE` assente e nessuna voce scelta dal
pannello), si parte con una voce nella lingua dell'interfaccia di Windows:
Windows in italiano → `if_sara` con Kokoro, e di conseguenza risposte,
versetti e commenti in italiano. Una voce scelta a mano vince sempre.
`DC_SYSTEM_LANGUAGE=en` forza un'altra lingua.

### Timer, promemoria, sveglie, azioni programmate

Si chiedono come a un assistente vocale, in chat o a voce:

| Chiedi | Succede |
|--------|---------|
| "metti un timer di 5 minuti", "timer 25 min per la pasta" | timer |
| "ricordami di chiamare Marco tra mezz'ora", "tra 30 min devo fare quello" | promemoria relativo |
| "alle 12:00 del 29/12/2027 ricordami del dentista", "domani alle 9 ricordami la riunione" | promemoria a data e ora |
| "ogni giorno alle 13 ricordami di pranzare" | promemoria quotidiano |
| "svegliami alle 7 e mezza", "wake me up at 6:30 am" | sveglia |
| "quanto manca?", "annulla il timer", "quali promemoria ho?" | comandi |

Le richieste in italiano e in inglese si capiscono senza il cervello
(`backend/reminders.py`): la conferma è immediata e funziona anche col
risponditore offline. Il resto lo capisce il cervello, che risponde con
un'etichetta nascosta `[[remind {...}]]` (mai letta ad alta voce); con
`"do"` è un'**azione**: all'ora giusta il testo va al cervello come un compito
("tra un'ora controlla se la build è passata"). Quando scatta: campanello,
bussa sul vetro, lo dice, e arriva una notifica di Windows. I promemoria stanno
in `state/reminders.json`; quelli persi a PC spento li dice al ritorno (fino a
12 ore dopo). La scheda **Agenda** li mostra con il conto alla rovescia.

### Cosa stai facendo al PC

Ogni 5 secondi la shell Electron manda al backend da quanto non tocchi mouse e
tastiera, se lo schermo è bloccato e la finestra in primo piano (titolo,
programma, schermo intero). Diventa un'attività: programmi in VS Code, guardi
un video su YouTube (col titolo), giochi, sei in riunione... Serve a
commentare al momento giusto, a non disturbare (schermo intero, giochi,
riunioni) e a non addormentarsi mentre guardi un video. Questi dati restano
sul PC. `GET /api/context` mostra cosa vede.

### Commenti spontanei

| Quando | Cosa dice |
|--------|-----------|
| **Ora tarda** | all'una sei ancora lì: "È l'una e 12! Vai a dormire, hai programmato abbastanza per oggi" (e sbadiglia) |
| **Pause** | due ore di fila al PC: una pausa, stiracchiandosi |
| **Meteo** | il buongiorno col tempo che fa; il caldo (si fa aria), il freddo (trema), la pioggia che comincia |
| **Batteria** | al 20, 10 e 5%, finché non attacchi il caricabatterie |
| **YouTube** | un commento sul video che stai guardando o sul suo creator |
| **Chiacchiere** | una notizia di oggi, una curiosità, un film da vedere |

Le frasi fisse (ora, pause, meteo, batteria) sono pronte in italiano e in
inglese; i commenti su video, notizie e curiosità li scrive il cervello, con un
messaggio che non compare in chat come se l'avessi scritto tu (col risponditore
offline restano le frasi fisse). Mai a schermo intero, in riunione, in un gioco
o se non sei al PC, mai mentre sta già parlando, e fra due commenti passano
almeno 8 minuti. Nel pannello (Personaggio → Chiacchiere) si sceglie quanto
parla (mai, poco, normale, tanto) e di cosa; `DC_PROACTIVE=0` spegne tutto.

Il meteo viene da [Open-Meteo](https://open-meteo.com) (gratis, senza chiave);
la posizione è la città scritta nel pannello o, se è vuota, quella approssimata
dall'indirizzo IP (get.geojs.io). Le notizie sono i titoli del feed RSS di
Google News nella lingua del sistema. Sono le uniche richieste che partono dal
PC per i commenti, e solo se l'argomento è acceso.

### File e schermo

Trascina un file su di lei o sulla chat (o usa la graffetta): un agente riceve
il percorso e il permesso di leggerlo (`--add-dir` per Claude Code, `-i` per le
immagini di Codex), un modello riceve il testo del file e le immagini nel
messaggio (se il modello le vede). **"Guarda lo schermo"**, scritto o detto, fa
uno screenshot dello schermo dove sta il cursore e lo passa al cervello; c'è
anche il pulsante *Schermo* in chat e la voce nel menu della tray. Lo
screenshot si fa solo quando lo chiedi.

### Mentre un agente lavora

Claude Code, Codex e OpenClaw possono lavorare un minuto prima di rispondere.
In quel tempo lei racconta cosa stanno facendo: i tool che usano diventano
passi leggibili ("legge main.js", "esegue git status", "cerca in rete
«meteo»") nella bolla e nella chat, e la posa cambia (tablet per leggere,
tastiera per scrivere). Se l'agente tace per 7 secondi dice "un attimo, ci
sto lavorando" con la voce in uso (e dopo 45 "ancora un pochino"); a risposta
arrivata i passi restano sotto il messaggio, chiusi ("3 passi"). Il puntatore
sopra la risposta dice quanto ha fatto aspettare (primo testo, prima voce,
totale). Il ragionamento interno degli agenti non viene mai letto.

### Interromperla a voce

In ascolto continuo e a chiamata il microfono resta aperto anche mentre lei
parla, ma "sorvegliato": serve una voce forte e continua per mezzo secondo, e
il backend scarta le trascrizioni che sono la sua stessa voce tornata dal
microfono. Se le parli sopra si ferma e ti ascolta. Con casse alte e senza
cuffie, se si interrompe da sola, spegni Personaggio → Microfono → **Puoi
interromperla parlando**. La prima frase di ogni risposta parte dal primo
inciso, senza aspettare il punto: la senti prima.

### Chi è e cosa sa di te

Nome e carattere si scelgono in Personaggio → **Chi è e cosa sa di te** e
valgono per ogni cervello: cambiando agente o modello resta la stessa. Lo
stesso vale per i ricordi: dille "ricordati che lavoro in Python", chiedi
"cosa ricordi di me?", "dimentica che..."; anche il cervello può annotarne uno
da solo quando gli racconti qualcosa di duraturo. Stanno in
`state/memory.json`, si vedono e si cancellano dal pannello, e partono solo
dentro il messaggio al cervello che hai scelto tu.

### Avvisi da Claude Code e Codex

Se usi Claude Code o Codex per conto tuo (in un terminale, in VS Code), lei ti
chiama quando hanno finito o quando ti aspettano per un permesso: se sei
altrove suona, bussa e lo dice ("Claude Code ha finito: ho aggiunto i test");
se stai già guardando l'editor basta una bolla; a schermo intero solo la
notifica di Windows. Si attiva da Personaggio → **Avvisi dagli agenti**, che
aggiunge (con una copia di sicurezza `.tsukumo-bak`):

- a `~/.claude/settings.json` gli hook `Stop` e `Notification`, che lanciano
  `scripts/tsukumo_notify.py` (forma `command` + `args`: va sia con bash sia
  con PowerShell);
- a `~/.codex/config.toml` la riga `notify = [...]` (se ne hai già una non la
  tocca).

Lo script esce subito se Tsukumo è spento (non trova `state/running.json`) e
ignora gli agenti lanciati da Tsukumo stesso (`TSUKUMO_INTERNAL=1`). Anche una
sua risposta che ci mette più di 25 secondi, se nel frattempo sei passato ad
altro, arriva col campanello.

---

## Configurazione

Copia `.env.example` in `.env` e modifica quello che ti serve; in alternativa
usa direttamente le variabili d'ambiente (hanno la precedenza sul file).

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `DC_HOST` / `DC_PORT` | `127.0.0.1` / `8770` | indirizzo del backend |
| `DC_LLM_BACKEND` | primo trovato, altrimenti `ollama` | il cervello: `claude_code`, `codex`, `openclaw`, `hermes`, `command`, `openai` (LM Studio e affini), `ollama`, `anthropic`, `gemini`, `groq`, `openrouter`, `deepseek`, `mistral`, `together`, `mock` |
| `DC_OLLAMA_URL` | `http://127.0.0.1:11434` | endpoint di Ollama |
| `DC_OLLAMA_MODEL` | `llama3.2` | modello da usare con Ollama |
| `DC_OPENAI_BASE_URL` | `http://127.0.0.1:1234/v1` | endpoint stile OpenAI (default di LM Studio) |
| `DC_OPENAI_MODEL` | `auto` | modello da usare, o `auto` per il primo caricato |
| `DC_OPENAI_API_KEY` | *(vuoto)* | quasi mai necessaria per un server locale |
| `DC_OPENCLAW_URL` | `http://127.0.0.1:18789` | Gateway OpenClaw |
| `DC_OPENCLAW_AGENT_ID` | `main` | quale agente OpenClaw "diventa" il companion (meglio un agente dedicato: vedi sopra) |
| `DC_OPENCLAW_TOKEN` | *(vuoto)* | letto da `~/.openclaw/openclaw.json` se vuoto |
| `DC_CLAUDE_CODE_MODEL` / `_CWD` / `_TOOLS` | account / home / web+lettura | modello, cartella e strumenti di Claude Code |
| `DC_CODEX_MODEL` / `_CWD` / `_SANDBOX` | config.toml / home / `read-only` | modello, cartella e permessi di Codex |
| `DC_HERMES_BASE_URL` | `http://127.0.0.1:8642/v1` | API server di Hermes Agent |
| `DC_AGENT_COMMAND` | *(vuoto)* | il comando dell'agente generico, con `{prompt}` |
| `DC_LLM_FALLBACK` | `0` | se il cervello non risponde, rispondi con il mock invece di mostrare l'errore |
| `DC_STATUS_INTERVAL` | `10` | secondi fra un controllo dei motori e l'altro |
| `DC_DETECT_ENGINES` | `1` | all'avvio cerca i cervelli installati (badge "Trovato sul PC"; sceglie il primo se `DC_LLM_BACKEND` manca) |
| `DC_PROACTIVE` | `1` | commenti spontanei (ora tarda, meteo, batteria, YouTube, notizie); quanto e di cosa si sceglie dal pannello |
| `DC_SYSTEM_LANGUAGE` | lingua di Windows | forza la lingua con cui partire se nessuno ha scelto una voce |
| `DC_ANIMATIONS_DIR` | `frontend/public/animations` | cartella delle clip `.vrma` |
| `DC_SYSTEM_PROMPT` | vedi `config.py` | personalità (solo per i modelli: gli agenti hanno la loro) |
| `DC_HISTORY_TURNS` | `12` | turni di conversazione ricordati (gli agenti ricordano da sé) |
| `DC_TTS_ENGINE` | `kokoro` | `kokoro`, `kokoro_http`, `piper`, `system`, `elevenlabs`, `openai_tts`, `azure`, `google_tts`, `cartesia`, `edge`, `formant` |
| `DC_VOICE` | nella lingua del sistema | voce Kokoro (gli altri motori hanno il loro campo, es. `DC_ELEVENLABS_VOICE`) |
| `DC_SPEED` | `1.0` | velocità di lettura |
| `DC_LANGUAGE` | `en-us` | pronuncia di riserva, se il nome della voce non dice la lingua |
| `DC_REPLY_LANGUAGE` | `auto` | `auto` (lingua della voce), `same` (lingua in cui scrivi) o una lingua (`English`, `it`...) |
| `DC_TTS_FALLBACK` | `1` | se la voce non parte all'avvio, usa la voce di servizio (il pannello dice perché) |
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

Le voci Microsoft e Google lo dicono col prefisso (`it-IT-ElsaNeural`); le voci
**multilingua** (ElevenLabs, OpenAI, le `…Multilingual…` di Azure) sanno
pronunciare tutto, e con loro risponde nella lingua in cui scrivi. Con
ElevenLabs e Cartesia la lingua si può anche forzare dal pannello.

A ogni turno il backend aggiunge al cervello un'istruzione esplicita ("rispondi
sempre in inglese, testo semplice, niente emoji"). Gli agenti, che hanno una
personalità loro e non ricevono il nostro system prompt, la ricevono davanti al
messaggio (Claude Code come `--append-system-prompt`): senza, risponderebbero
nella lingua in cui scrivi e in markdown.

Voce e lingua si cambiano al volo dal pannello; da `.env`:

```env
DC_VOICE=if_sara
# auto = lingua della voce (default), same = lingua in cui scrivi, oppure una lingua
DC_REPLY_LANGUAGE=auto
```

L'elenco completo delle voci disponibili è in `GET /api/voices` e nella
tendina del pannello, raggruppato per lingua.

### Lo stato dei motori

Prima c'era una spia sola, per il Gateway OpenClaw, anche quando il cervello
era un altro. Ora il backend controlla **qualunque** motore attivo ogni
`DC_STATUS_INTERVAL` secondi e avvisa solo quando qualcosa cambia (messaggio
WebSocket `engines`). Lo stato si vede nell'anello del cervello accanto al
personaggio, nel cerchio accanto al nome nel pannello, nella scheda Motori:

| Colore | Stato | Significato |
|--------|-------|-------------|
| 🟢 verde | `online` | risponde |
| 🟡 giallo | `degraded` | risponde, ma con un problema (Gateway non pronto, modello non caricato, ultimo turno fallito, voce di ripiego) |
| 🔴 rosso | `offline` | non raggiungibile: il motivo è scritto accanto |
| ⚪ grigio | `unknown` / `off` | non ancora controllato, o spento di proposito (ascolto disattivato) |

Ogni motore sa controllarsi senza effetti collaterali: OpenClaw con le probe
pubbliche del Gateway (`/health` e `/readyz`, senza token e senza aprire la
chat), Claude Code e Codex cercando il programma e il login, i server HTTP con
una richiesta leggera. Nessun controllo può bloccare il backend: `/api/health`
risponde sempre subito dalla cache. Era proprio un controllo di OpenClaw fatto
dentro `/api/health`, col Gateway spento, a far dare per morto il backend
all'avvio dal desktop.

```bash
curl http://127.0.0.1:8770/api/status     # forza un controllo adesso
```

### Le voci

| `DC_TTS_ENGINE` | Cosa usa | Costo |
|-----------------|----------|-------|
| `kokoro` | `kokoro-onnx` in-process, tempi esatti per fonema | **default**, gratis e locale |
| `kokoro_http` | un server [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) già avviato | gratis |
| `piper` | voci Piper leggerissime | gratis |
| `system` | le voci di Windows (SAPI) | gratis |
| `elevenlabs` | ElevenLabs, con i tempi di ogni lettera per il lip-sync | piano gratuito, poi a consumo |
| `openai_tts` | `gpt-4o-mini-tts` (accetta istruzioni sul tono) o qualunque server `/v1/audio/speech` | a consumo |
| `azure` | Azure Speech, centinaia di voci neurali | 500 mila caratteri gratis al mese |
| `google_tts` | Google Cloud Text-to-Speech | quota gratuita mensile |
| `cartesia` | Cartesia Sonic, latenza bassissima | piano gratuito, poi a consumo |
| `edge` | le voci di Microsoft Edge, senza chiave (servizio non ufficiale) | gratis |
| `formant` | sintetizzatore di vocali integrato, per provare il lip-sync | gratis |

Per le voci a pagamento la scheda Motori fa quasi tutto da sola: incolli la
chiave, premi **Verifica** e vedi se è valida, le voci del tuo account (che
diventano suggerimenti nel campo Voce) e, per ElevenLabs, quanti caratteri ti
restano nel mese e quando si rinnova il piano. Poi **Usa questo**: se qualcosa
non va il backend rimette il motore di prima e ti dice perché, invece di
ripiegare in silenzio su una voce robotica. Il selettore delle voci nella
scheda Personaggio si riempie con l'elenco del motore attivo; ogni motore
ricorda la sua voce.

Con ElevenLabs il companion chiede l'endpoint `with-timestamps`: oltre
all'audio arrivano l'inizio e la fine di ogni lettera, e la bocca resta
precisa quanto con Kokoro. Tutte le voci in rete chiedono audio PCM grezzo (o
WAV), quindi non serve nessun decoder in più.

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
{ "type": "chat",   "text": "ciao, come va?" }   // cervello + voce
{ "type": "say",    "text": "buongiorno", "voice": "if_sara" }   // solo voce
{ "type": "settings", "voice": "if_sara", "replyLanguage": "auto", "muted": false }  // a caldo
{ "type": "voice",  "audio": "<pcm16 16 kHz in base64>" }         // dal microfono
{ "type": "cancel" }                              // interrompe il turno
{ "type": "reset" }                               // svuota la conversazione
{ "type": "ping" }
```

**Server → client**

```jsonc
{ "type": "hello",  "version": "2.0.0", "config": {...}, "voices": [...],
                    "engines": {...}, "blendshapes": {...}, "avatar": {...} }
{ "type": "engines", "llm": { "id": "claude_code", "label": "Claude Code",
                              "state": "online", "detail": null, ... },
                     "tts": {...}, "stt": {...} }  // solo quando qualcosa cambia
{ "type": "voices", "voices": [ { "id": "if_sara", "name": "Sara",
                     "language": "it", "gender": "female", "preview": "" } ] }
{ "type": "state",  "value": "thinking" | "speaking" | "idle" }
{ "type": "token",  "text": "frammento " }        // streaming dell'LLM
{ "type": "speech", "text": "Ciao!", "format": "wav", "sampleRate": 24000,
                    "duration": 1.42, "audio": "<wav in base64>",
                    "visemes": [ { "t": 0.08, "d": 0.11, "v": "a", "w": 0.73 } ],
                    "mood": "happy" }             // umore dalle emoji tolte, o null
{ "type": "caption", "text": "Ciao!" }         // frase senza audio (voce spenta o guasta)
{ "type": "settings", "voice": "...", "replyLanguage": "auto", "replyLanguageResolved": "English",
                    "voiceLanguage": "en", "muted": false }
{ "type": "reply",  "text": "risposta completa", "elapsed": 2.31, "failed": false }
{ "type": "notice" | "error", "message": "...", "source": "llm" | "tts" | "stt",
                    "hint": "come rimediare", "action": "engines" }
{ "type": "pong" }
```

Nella timeline: `t` = istante di inizio in secondi, `d` = durata, `v` = viseme
(`a`/`i`/`u`/`e`/`o`/`sil`), `w` = peso 0–1.

I messaggi sono inviati in **broadcast** a tutti i client collegati: se apri
due finestre, entrambe mostrano lo stesso avatar parlare.

### REST

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| `GET` | `/api/health` | vivo? Risponde sempre subito, con l'ultimo stato noto dei motori |
| `GET` | `/api/status` | stato dei motori, forzando un controllo |
| `GET` | `/api/config` | configurazione pubblica e mappa delle blendshape |
| `GET` | `/api/providers` | tutti i motori con i loro schemi, quelli attivi, i valori salvati (segreti mascherati) e quelli trovati sul PC (`detected`) |
| `POST` | `/api/providers/check` | prova un motore con dei valori, **senza** attivarlo |
| `POST` | `/api/providers` | attiva un motore (salva in `.env`, ripristina se fallisce) |
| `GET` | `/api/voices` | voci del motore attivo, con lingua e genere |
| `POST` | `/api/say` | sintetizza un testo (l'audio va ai client WS) |
| `POST` | `/api/vocal` | un versetto (`greet`, `morning`, `evening`, `night`, `welcome`, `pat`, `poke`, `lift`, `fall`) con la voce in uso, restituito solo a chi lo chiede |
| `POST` | `/api/chat` | turno completo con l'LLM |
| `POST` | `/api/vocal` | un versetto con la voce in uso (vedi sopra) |
| `GET` / `POST` / `DELETE` | `/api/reminders` | timer e promemoria; `POST` con `{"phrase": "tra 20 minuti ricordami di bere"}` o con i campi |
| `POST` / `GET` | `/api/context` | cosa fa l'utente al PC (lo manda la shell ogni 5 s) |
| `GET` / `POST` | `/api/preferences` | quanto chiacchiera, di cosa, città del meteo |
| `GET` | `/api/weather` | il meteo che vede (passa dalla rete) |
| `POST` | `/api/notify` | un agente esterno ha finito: `{"source": "claude", "message": "..."}` |
| `GET` / `POST` | `/api/integrations` | stato e collegamento degli hook di Claude Code e Codex |
| `POST` | `/api/attachments?name=file.png` | carica un file (dal browser, che non conosce i percorsi) |
| `GET` | `/api/animations` | le clip `.vrma` disponibili |
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
│   ├── server.py          # FastAPI: WebSocket, REST, verifica/cambio motori, file statici
│   ├── pipeline.py        # cervello -> frasi -> voce -> visemi -> broadcast
│   ├── status.py          # stato dei motori attivi (sostituisce la vecchia spia OpenClaw)
│   ├── providers.py       # registro dei motori: schema, categoria, costo
│   ├── provider_specs.py  # la dichiarazione di ogni motore: il pannello si disegna da qui
│   ├── config.py          # impostazioni da env / .env
│   ├── languages.py       # lingua della voce e lingua delle risposte
│   ├── vocals.py          # i versetti ("Ciao!", "Ehehe!") per evento e lingua
│   ├── reminders.py       # timer e promemoria: frasi naturali, etichette, archivio
│   ├── proactive.py       # commenti spontanei (ora tarda, meteo, batteria, YouTube...)
│   ├── context.py         # cosa sta facendo l'utente al PC
│   ├── weather.py / news.py / system.py   # Open-Meteo, Google News RSS, batteria
│   ├── preferences.py     # quanto chiacchiera e di cosa (state/preferences.json)
│   ├── attachments.py     # file e screenshot per agenti e modelli
│   ├── notify.py          # avvisi da Claude Code e Codex (hook)
│   ├── audio.py           # WAV, base64, inviluppo RMS
│   ├── phonemes.py        # IPA, G2P e tempi per lettera -> visemi (fcl_mth_*)
│   ├── visemes.py         # allineamento fonemi <-> energia dell'audio
│   ├── llm/               # cli_agents.py (Claude Code, Codex, comando), openclaw.py,
│   │                      # openai_compatible.py (LM Studio, cloud, Hermes), ollama.py,
│   │                      # anthropic.py, gemini.py, mock.py, detect.py (chi c'è sul PC)
│   ├── tts/               # kokoro_engine.py, kokoro_http.py, elevenlabs.py,
│   │                      # cloud.py (OpenAI, Azure, Google, Cartesia), edge.py, piper.py,
│   │                      # system.py, formant.py
│   └── stt/               # faster_whisper_engine.py, http_engines.py
├── frontend/
│   ├── index.html         # il personaggio
│   ├── panel.html         # il pannello
│   └── src/
│       ├── main.js        # collega tutti i pezzi del personaggio
│       ├── hud.js         # i dock ad arco ai suoi lati
│       ├── vrm.js         # Three.js + three-vrm, sguardo, blink, blendshape
│       ├── body.js        # animazione del corpo: postura, IK, gesti, reazioni
│       ├── body/          # motion.js, pose.js, actions.js, constants.js
│       ├── vocals.js      # quando dire un versetto (saluto, carezza, caduta)
│       ├── presence.js    # sonno e risveglio, da quanto il PC è fermo
│       ├── sfx.js         # effetti sonori sintetizzati
│       ├── clips.js       # clip .vrma mescolate al corpo procedurale
│       ├── panel/agenda.js # scheda Agenda: timer e promemoria
│       ├── panel.js       # il pannello: schede, testata, connessione
│       ├── panel/         # chat.js, character.js (voci, aspetto, comportamento)
│       ├── engines.js     # scheda Motori, disegnata da /api/providers
│       ├── markdown.js    # markdown sicuro per la chat
│       ├── icons.js       # icone a tratto, offline
│       ├── lipsync.js     # timeline + RMS -> pesi della bocca
│       ├── audio.js       # coda WebAudio + misura RMS
│       ├── ws.js          # WebSocket con riconnessione
│       ├── ui.js          # DOM del personaggio
│       └── theme.css, style.css, panel.css
├── electron/
│   ├── main.js            # finestre, avvio del backend con attesa e riprova, icona, IPC
│   ├── pet-physics.js     # cadute, barra, bordi, finestre su cui sedersi
│   ├── desktop.js         # finestre degli altri programmi (Windows, via koffi)
│   └── preload.js
├── tests/                 # pytest: testo, lingue, visemi, agenti, pipeline, API, promemoria, commenti, allegati
├── scripts/
│   ├── download_models.py # pesi Kokoro, con ripresa del download
│   └── tsukumo_notify.py  # hook di Claude Code e Codex: "ho finito"
├── models/                # <- i pesi finiscono qui (non versionati)
├── state/                 # sessioni degli agenti, promemoria, preferenze (non versionate)
├── Tsukumo.vbs            # avvio dal desktop senza terminale
├── requirements.txt / requirements-dev.txt
├── start.ps1 / start.sh   # -Setup, -Dev, -Electron, -Shortcut, -Test
└── .env.example
```

---

## Risoluzione dei problemi

**Doppio click sul collegamento e non succede niente, o «Non riesco ad avviare Tsukumo»**
Il biglietto accanto al personaggio mostra le ultime righe del backend; il resto
è in `logs\companion.log` (icona nell'area di notifica → **Apri il log**). Le
cause più comuni: dipendenze Python mancanti (`.\start.ps1 -Setup`), un altro
programma sulla porta 8770 (cambia `DC_PORT`), frontend non compilato. Dopo aver
sistemato, **Riavvia** dalla stessa icona.

**Il cervello non risponde**
Nella chat compare una scheda rossa con il motivo e un tasto per la scheda
Motori; lì **Verifica** ripete il controllo e dice cosa manca. Per OpenClaw
controlla che il Gateway sia acceso (`openclaw gateway status`); per Claude
Code e Codex che il programma sia installato e abbia fatto il login; per i
servizi in rete la chiave. Se l'agente risponde ma con un errore suo ("provider
rejected the request schema or tool payload" di OpenClaw, per esempio) il
problema è nella configurazione dell'agente, non in Tsukumo.

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
Agli agenti il system prompt non passa (la personalità è la loro): ricevono
invece la regola del parlato davanti al messaggio, e il resto lo toglie la
ripulitura lato backend. In chat il markdown resta, formattato.

**Errori ONNX Runtime all'avvio (`DLL load failed`, `onnxruntime` non importabile)**
Su Windows serve il
[Visual C++ Redistributable 2015-2022](https://aka.ms/vs/17/release/vc_redist.x64.exe).
Nel frattempo il backend continua a funzionare con `DC_TTS_ENGINE=formant`.

**La finestra Electron è tutta nera invece che trasparente**
Su alcune configurazioni Linux la trasparenza richiede un compositore attivo.

**Test**
`.\start.ps1 -Test` (o `./start.sh --test`) esegue i test del backend: testo
e frasi, lingue, visemi, parser degli agenti con righe registrate dal vivo,
pipeline con errori e interruzioni, API e WebSocket. Non usano rete, modelli
né il tuo `.env`.

---

## Licenza

Tsukumo è distribuito sotto **GNU AGPL v3** (testo completo in
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
- **Sendagaya Shino** — avatar dell'installer, modello di esempio di VRoid
  Studio (pixiv), CC0
- **three.js**, **@pixiv/three-vrm** — MIT
- **Electron**, **FastAPI**, **ONNX Runtime** — MIT / Apache 2.0
- **Il tuo modello VRM** — licenza dell'autore: se lo hai scaricato, controlla
  cosa permette (uso commerciale, modifiche, ridistribuzione).
