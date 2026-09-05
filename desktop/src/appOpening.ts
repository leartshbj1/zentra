// A connected account can require two native network requests, each bounded
// at 30 seconds. Leave room for local storage without waiting indefinitely.
export const APP_OPEN_TIMEOUT_MS = 75_000;

export function withinAppOpeningDeadline<T>(request: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        'L’ouverture prend trop de temps. Réessayez. Si le problème persiste, fermez puis rouvrez l’application.',
      ));
    }, APP_OPEN_TIMEOUT_MS);

    // Settling the wrapper also prevents a late response from changing the
    // result of an expired attempt. The native request itself is not cancelled.
    request.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
