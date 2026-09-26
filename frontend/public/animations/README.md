# Animazioni `.vrma`

Metti qui le clip VRM Animation (`.vrma`): Tsukumo le mescola al suo movimento
procedurale (respiro, peso, sguardo restano suoi). Il nome del file dice
quando usarle:

| Nome | Quando |
|------|--------|
| `greet*.vrma` (o `wave*`, `hello*`) | al posto del saluto con la mano, quando compare o quando torni |
| `idle*.vrma` | ogni tanto, fra i gesti spontanei (in piedi) |
| `dance*.vrma` | in loop mentre Spotify suona, se "Balla con Spotify" è acceso |
| `inchino*.vrma` (o `bow*`) | quando la ringrazi ("grazie", "thanks"...), e dal pannello |
| `alza*.vrma` (o `here*`, `raise*`) | quando la chiami per nome in ascolto a chiamata, e dal pannello |
| tutte le altre | a richiesta, dai pulsanti in Personaggio → Falle fare qualcosa |

Si usano solo le rotazioni delle ossa: lo spostamento dei fianchi e le
espressioni della clip vengono ignorati, cosi' il personaggio non esce dalla
finestra e la faccia resta quella del lip-sync. Le clip in piedi funzionano
meglio: da seduta o sdraiata non partono.

## Da un BVH qualsiasi

```
node scripts/bvh2vrma.mjs clip.bvh frontend/public/animations/greet-mio.vrma --trim
```

Riconosce gli scheletri Bandai Namco, Mixamo, CMU e i nomi più comuni, e
porta la clip in T-pose qualunque sia la posa di riposo del BVH (il primo
fotogramma deve essere l'attore in piedi, fermo). `--trim` toglie l'attesa
immobile prima e dopo il gesto; di norma resta rivolta verso di te anche se
l'attore si girava, `--free-facing` lo evita.

Altre fonti: il pacchetto gratuito di animazioni VRMA di VRoid (pixiv), o clip
convertite da altri formati. Controlla la licenza di ciascuna: i file `.vrma`
di questa cartella non finiscono nel repository.

Dopo aver aggiunto o tolto file, riavvia Tsukumo (o ricarica il personaggio).
