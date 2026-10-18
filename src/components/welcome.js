// What a new install still lacks before the copilot can listen and answer.

const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3-int8';
export { PARAKEET_MODEL };

/**
 * `provider`: no provider can answer (no CLI logged in, no valid API key). "unknown"
 * (the check itself failed) counts as usable, as everywhere else in the app.
 * `speech`: the chosen recognition engine is not ready.
 * `known`: both checks have finished, so a missing piece is real and not pending.
 */
export function welcomeNeeds(availability, speechStatus) {
  const entries = Object.values(availability || {});
  const known = entries.length > 0 && !entries.some((entry) => entry?.status === 'checking') && !!speechStatus;
  return {
    known,
    provider: !entries.some((entry) => entry?.status === 'available' || entry?.status === 'unknown'),
    speech: !speechStatus?.engines?.[speechStatus?.engine]?.ready,
  };
}
