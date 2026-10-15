import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readArg(name, defaultValue = '') {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return defaultValue;
  return process.argv[index + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizePercent(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value)) return null;
  const ratio = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function findBundledBrowser() {
  const explicit = readArg('--browser-executable') || process.env.REMOTION_BROWSER_EXE || '';
  const candidates = [
    explicit,
    path.join(__dirname, 'node_modules', '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    path.join(__dirname, 'chrome-headless-shell', 'chrome-headless-shell.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  fail([
    '没有找到内置 Chrome Headless Shell，无法使用 Remotion 生成素材。',
    '请确认以下文件存在：',
    path.join(__dirname, 'node_modules', '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
  ].join('\n'));
}

const planPath = readArg('--plan');
const outputPath = readArg('--output');
const componentPath = readArg('--component');
if (!planPath) fail('缺少 --plan 参数');
if (!outputPath) fail('缺少 --output 参数');
if (!componentPath) fail('缺少 --component 参数');
if (!fs.existsSync(planPath)) fail(`没有找到素材计划文件: ${planPath}`);
if (componentPath && !fs.existsSync(componentPath)) fail(`没有找到 Remotion 动态组件: ${componentPath}`);

const browserExecutable = findBundledBrowser();
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8').replace(/^\uFEFF/, ''));
const normalizedPlan = {
  ...plan,
  engine: 'remotion',
  duration: Math.min(180, Math.max(1, Number(plan.duration || 6))),
};

const srcDir = path.join(__dirname, 'src');
fs.mkdirSync(srcDir, { recursive: true });
fs.copyFileSync(componentPath, path.join(srcDir, 'AiGeneratedMaterialVideo.jsx'));
fs.writeFileSync(path.join(srcDir, 'active-plan.json'), JSON.stringify(normalizedPlan, null, 2), 'utf8');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

console.log('Remotion 渲染器启动');
console.log(`计划文件: ${planPath}`);
console.log(`输出文件: ${outputPath}`);
console.log(`动态组件: ${componentPath}`);
console.log(`渲染时长: ${normalizedPlan.duration}s`);
console.log(`内置浏览器: ${browserExecutable}`);

let lastBundlePercent = -1;
let lastRenderPercent = -1;
const entryPoint = path.join(srcDir, 'index.jsx');
const serveUrl = await bundle({
  entryPoint,
  onProgress: (progress) => {
    const percent = normalizePercent(progress);
    if (percent !== null && percent !== lastBundlePercent && percent % 10 === 0) {
      lastBundlePercent = percent;
      console.log(`Remotion 打包进度: ${percent}%`);
    }
  },
});

const composition = await selectComposition({
  serveUrl,
  id: 'GeneratedMaterial',
  inputProps: { plan: normalizedPlan },
  browserExecutable,
  chromeMode: 'headless-shell',
});

await renderMedia({
  composition,
  serveUrl,
  codec: 'h264',
  hardwareAcceleration: 'if-possible',
  outputLocation: outputPath,
  inputProps: { plan: normalizedPlan },
  browserExecutable,
  chromeMode: 'headless-shell',
  onProgress: ({ progress }) => {
    const percent = normalizePercent(progress);
    if (percent !== null && percent !== lastRenderPercent && (percent % 5 === 0 || percent === 100)) {
      lastRenderPercent = percent;
      console.log(`Remotion 渲染进度: ${percent}%`);
    }
  },
});

console.log(`Remotion 渲染完成: ${outputPath}`);
