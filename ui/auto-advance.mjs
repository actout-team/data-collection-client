// Advance on completion, not when revisiting an already completed page.
// The delay leaves time for the successful state to be painted.
export function createAutoAdvance(advance, { schedule = setTimeout, cancel = clearTimeout, delay = 900 } = {}) {
  let previous, timer;
  return ({ step, ready }) => {
    const changedPage = previous && previous.step !== step;
    const completed = ready && (previous ? !changedPage && !previous.ready : step === 0);
    if (timer !== undefined && (changedPage || !ready)) { cancel(timer); timer = undefined; }
    previous = { step, ready };
    if (completed && timer === undefined) timer = schedule(() => {
      timer = undefined;
      if (previous.step === step && previous.ready) advance(step + 1);
    }, delay);
  };
}
