/**
 * Petits utilitaires de test partagés (hors coverage). Rien de spécifique au
 * framework ici — juste de quoi lire les arguments d'un `jest.Mock` sans passer
 * par `any` (ce que la config ESLint `recommendedTypeChecked` interdit).
 */

/** Arguments (tuple) du n-ième appel d'un mock, typé `T`. */
export function callArgs<T extends unknown[]>(mock: jest.Mock, call = 0): T {
  return (mock.mock.calls as unknown[][])[call] as T;
}

/** Premier argument du n-ième appel d'un mock, typé `T`. */
export function argOf<T>(mock: jest.Mock, call = 0, arg = 0): T {
  return (mock.mock.calls as unknown[][])[call][arg] as T;
}
