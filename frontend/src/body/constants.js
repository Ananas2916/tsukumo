/**
 * Costanti del corpo: modalita', posture, tempi dei gesti spontanei.
 */

export const SIDES = ['left', 'right'];
export const MOODS = ['happy', 'relaxed', 'surprised', 'sad', 'angry'];
export const PHALANGES = ['Proximal', 'Intermediate', 'Distal'];
export const MODES = ['stand', 'sit', 'lie', 'side', 'edge', 'held', 'fall'];
/** Modalita' "a riposo", in cui ha senso fare gesti spontanei. */
export const RESTING = ['stand', 'sit', 'lie', 'side', 'edge'];
/** Posture possibili sulla barra delle applicazioni. */
export const POSTURES = ['stand', 'sit', 'lie', 'side'];
export const EPSILON = 0.001;

/** Velocita' con cui si entra in ciascuna modalita' (1/s): sdraiarsi e' un "tonfo" lento. */
export const MODE_RATES = { stand: 8, sit: 6, lie: 3, side: 3, edge: 6, held: 8, fall: 10 };

/** Piega a riposo delle dita, per falange: il mignolo si chiude piu' dell'indice. */
export const FINGER_REST = {
  Index: [0.14, 0.24, 0.18],
  Middle: [0.2, 0.3, 0.22],
  Ring: [0.26, 0.34, 0.24],
  Little: [0.32, 0.38, 0.26],
};

/** Quanto spesso parte un'azione spontanea quando e' tranquillo (secondi). */
export const FIDGET_DELAY = [7, 16];
/** Ogni quanto valuta di sedersi o sdraiarsi sulla barra (secondi). */
export const POSTURE_DELAY = [22, 50];

/** Presa per la collottola: il corpo si inclina in avanti sotto il punto di presa. */
export const HOLD_PITCH = 0.28;
/** Aggrappata al bordo dello schermo: quanto si sporge verso l'interno. */
export const EDGE_LEAN = 0.34;
