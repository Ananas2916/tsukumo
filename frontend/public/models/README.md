# Metti qui il tuo avatar

Copia in questa cartella un file `.vrm` e chiamalo **`avatar.vrm`**:

```
frontend/public/models/avatar.vrm
```

L'applicazione lo carica automaticamente all'avvio. Se il nome e' diverso, il
backend prende comunque il primo `.vrm` che trova qui dentro (vedi
`GET /api/config` -> `avatar.default`). Puoi anche trascinare un `.vrm`
direttamente sulla finestra per caricarlo al volo.

## Dove prendere un modello

- **VRoid Studio** (gratuito, Windows/macOS): crea il tuo personaggio ed
  esporta in VRM.
- **VRoid Hub** / **Booth**: modelli di altri autori. Controlla sempre la
  licenza: molti vietano l'uso commerciale o le modifiche.

## Requisiti del modello

Per il lip-sync servono le blendshape della bocca. I modelli VRoid le hanno
gia':

| Viseme | VRM 0.x (morph target) | VRM 1.0 (expression preset) |
|--------|------------------------|-----------------------------|
| A      | `fcl_mth_a`            | `aa`                        |
| I      | `fcl_mth_i`            | `ih`                        |
| U      | `fcl_mth_u`            | `ou`                        |
| E      | `fcl_mth_e`            | `ee`                        |
| O      | `fcl_mth_o`            | `oh`                        |

Il renderer usa le espressioni preset quando ci sono, altrimenti pilota
direttamente i morph target `fcl_mth_*`. Se mancano entrambi, l'avatar viene
comunque mostrato: semplicemente non muove la bocca (lo dice anche il badge
in alto a sinistra).
