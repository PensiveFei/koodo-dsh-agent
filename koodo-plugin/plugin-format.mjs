/**
 * Koodo 插件的格式与校验规则 —— install.mjs 与 tests/ 共用这一份实现。
 *
 * 规则来自对 Koodo Reader 2.4.3 app.asar 的反编译结果：
 *   - 安装时只校验一件事：SHA256(UTF-8(script)) === scriptSHA256
 *     （generateSHA256Hash 走 crypto.subtle，输出小写十六进制；没有签名、没有白名单）
 *   - 字段集与官方插件一致（从 api.koodoreader.com/api/get_plugins 拉的 37 个真实对象）：
 *     identifier / type / displayName / icon / version / config / script / scriptSHA256 / langList
 *
 * script 的粘贴安全约束（踩过的坑）：script 里**不能出现双引号和反斜杠**。
 * 否则 JSON 里要写成 \" 转义，从聊天窗口或网页复制时极易丢反斜杠，
 * 而 Koodo 的安装代码 `JSON.parse(value)` 外面没有 try/catch —— 会静默抛异常、
 * 界面毫无反应（哈希不匹配反而会弹「插件验证失败」）。
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const HOOKS = ["translate", "getDictText"];
export const PLUGIN_TYPES = ["translation", "dictionary", "voice"];
export const ICONS = { translation: "translation", dictionary: "dict", voice: "speaker" };

/** 与 Koodo 的 generateSHA256Hash 对齐：UTF-8 字节 → SHA-256 → 小写 hex */
export function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * 生成引导式 script：只负责从磁盘读真正的面板脚本再执行。
 *
 * 优先用 `os.homedir()` 在渲染进程里**现算**路径（路径后缀是相对家目录的），
 * 这样即使家目录里有中文（`C:\Users\张三`），粘进 Koodo 的 JSON 也保持纯 ASCII ——
 * 复制粘贴过程中被改坏的概率最低。
 * 只有运行时目录不在家目录下时，才退化成嵌入绝对路径。
 */
export function bootstrapScript({ runtimeDir, panelFileName = "panel.js" }) {
  const panelPath = path.join(runtimeDir, panelFileName);
  const home = os.homedir();
  const rel = path.relative(home, panelPath);
  const underHome = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const relAscii = underHome && /^[\x20-\x7e]+$/.test(rel);

  if (relAscii) {
    const suffix = "/" + rel.replace(/\\/g, "/");
    const script =
      "(function(){var r=typeof require!=='undefined'?require:window.require;" +
      `eval(r('fs').readFileSync(r('os').homedir()+'${suffix}','utf8'));})();`;
    if (/["\\]/.test(script)) throw new Error("引导脚本含双引号或反斜杠，粘贴不安全");
    return { script, embeddedAbsolutePath: false };
  }
  return { script: bootstrapFor(panelPath), embeddedAbsolutePath: true };
}

/** 退路：把绝对路径直接嵌进去（路径里不能有引号/反斜杠） */
export function bootstrapFor(panelPath) {
  const p = String(panelPath).replace(/\\/g, "/");
  if (/["'\\]/.test(p)) {
    throw new Error(`路径含引号，无法生成粘贴安全的引导脚本：${p}`);
  }
  const script =
    "(function(){var r=typeof require!=='undefined'?require:window.require;" +
    `eval(r('fs').readFileSync('${p}','utf8'));})();`;
  if (/["\\]/.test(script)) throw new Error("引导脚本含双引号或反斜杠，粘贴不安全");
  return script;
}

/** 组装一个符合 Koodo 规范的插件对象 */
export function buildPlugin({ type, displayName, script, endpoint, icon, version = "1.0.0" }) {
  if (!PLUGIN_TYPES.includes(type)) throw new Error(`不支持的插件类型：${type}`);
  return {
    identifier: `koodo-dsh-agent-${type}`,
    type,
    displayName,
    icon: icon || ICONS[type],
    version,
    config: { endpoint },
    script,
    scriptSHA256: sha256(script),
    // 官方 schema 里 translation/dictionary 都带 langList。
    // 注意别用空字符串当键（官方 Pot 插件是 {"":"Automatic"}）：JS 的 JSON.parse 无所谓，
    // 但 Windows PowerShell 的 ConvertFrom-Json 会直接报错，诊断脚本就没法用了。
    langList: { Automatic: "Automatic" },
  };
}

/** 硬性问题：有任意一条，Koodo 一定装不上或装了不工作 */
export function validatePluginJson(text) {
  const problems = [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return [`JSON 解析失败：${e.message}`];
  }
  if (sha256(parsed.script ?? "") !== parsed.scriptSHA256) {
    problems.push("哈希不一致（Koodo 会弹「插件验证失败」）");
  }
  for (const field of ["identifier", "type", "displayName", "version", "config"]) {
    if (parsed[field] === undefined) problems.push(`缺字段 ${field}`);
  }
  // 缺 icon 会让 Koodo 写库时具名参数缺失，插入静默失败（界面毫无反应）
  if (!parsed.icon) problems.push('缺 icon（Koodo 写库会报 Missing named parameter "icon"）');
  if (/["\\]/.test(parsed.script ?? "")) problems.push("script 含双引号或反斜杠（粘贴不安全）");
  return problems;
}

/** 提示性问题：不致命，但值得知道 */
export function pluginWarnings(text) {
  const warnings = [];
  if (!/^[\x20-\x7e\r\n]*$/.test(text)) {
    warnings.push("JSON 含非 ASCII 字符（路径里有中文？手动复制时留意别被改坏）");
  }
  return warnings;
}
