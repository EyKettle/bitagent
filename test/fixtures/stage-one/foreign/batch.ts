console.log(`script saw ${counter}`);
counter += 3;
function scriptRead(): number { return counter; }
const scriptResult: number = counter * 2;
scriptResult;
