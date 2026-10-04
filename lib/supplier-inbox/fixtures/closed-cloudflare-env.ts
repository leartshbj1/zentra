// Test-only framework binding. The capture suite mocks the D1/R2 runtime
// boundary explicitly and must never inherit an authenticated platform env.
export const env = Object.freeze({});
