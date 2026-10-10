/**
 * Body constants: modes, postures, timing of the spontaneous gestures.
 */

export const SIDES = ['left', 'right'];
export const MOODS = ['happy', 'relaxed', 'surprised', 'sad', 'angry'];
export const PHALANGES = ['Proximal', 'Intermediate', 'Distal'];
export const MODES = ['stand', 'sit', 'lie', 'side', 'edge', 'held', 'fall'];
/** "Resting" modes, in which spontaneous gestures make sense. */
export const RESTING = ['stand', 'sit', 'lie', 'side', 'edge'];
/** Possible postures on the taskbar. */
export const POSTURES = ['stand', 'sit', 'lie', 'side'];
export const EPSILON = 0.001;

/** How fast each mode is entered (1/s): lying down is a slow "flop". */
export const MODE_RATES = { stand: 8, sit: 6, lie: 3, side: 3, edge: 6, held: 8, fall: 10 };

/** Resting bend of the fingers, per phalanx: the little finger closes more than the index. */
export const FINGER_REST = {
  Index: [0.14, 0.24, 0.18],
  Middle: [0.2, 0.3, 0.22],
  Ring: [0.26, 0.34, 0.24],
  Little: [0.32, 0.38, 0.26],
};

/** How often a spontaneous action starts when she is calm (seconds). */
export const FIDGET_DELAY = [7, 16];
/** How often she considers sitting or lying down on the taskbar (seconds). */
export const POSTURE_DELAY = [22, 50];

/** Held by the scruff: the body leans forward under the grab point. */
export const HOLD_PITCH = 0.28;
/** Clinging to the screen edge: how far she leans inwards. */
export const EDGE_LEAN = 0.34;
