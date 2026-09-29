import { captureStills } from "../src";
const r = await captureStills({ bundleDir: "/tmp/e2e-16x9/bundle", width: 1920, height: 1080, times: [2.5, 14, 27.5], outPath: (i) => `/tmp/still-${i}.jpg` });
console.log(JSON.stringify(r));
