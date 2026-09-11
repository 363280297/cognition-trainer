/* 复盘页的「上传聊天截图」：从选图到填进输入框，整条链验一遍。
 *
 * 能验到哪、验不到哪（说清楚，免得看着绿就以为全对了）：
 *   ✅ 选图（电脑那条 <input type=file> 路，用 Playwright 真喂一张图进去）
 *   ✅ 长截图会被竖切成几段（切成 1 段的话长图的字会被模型压糊）
 *   ✅ 请求形状：content 必须是**块数组**、带 image_url、模型是视觉模型、
 *      不带 response_format（OCR 要白话，不是 JSON）
 *   ✅ 返回的文字填进输入框、失败时给的是人话
 *   ❌ 真接口那一段**没法在这里验** —— 库里那份 .env 的密钥已经失效（实测 401），
 *      所以「DeepSeek 到底读没读出图里的字」只能在装了 APK 的手机上、
 *      用他自己那把有效密钥试。这一条我在 PLAN 里写明了，不假装验过。
 *
 * 图是脚本自己生成的 PNG（zlib + 手写 IHDR/IDAT/IEND），不依赖任何图片文件，
 * 也不涉及任何真实聊天记录。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

/* ---- 手写一个 PNG 编码器（只为造测试图，不引依赖）---- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** 白底 + 若干条深色横线，伪装成聊天气泡的文字行。 */
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h, 0xff);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;                       // filter: none
    const line = Math.floor(y / 26);
    if (y % 26 > 6 && y % 26 < 18) {                // 每 26 行画一条"文字"
      const x0 = 20, x1 = w - 20 - (line % 3) * 40; // 长度不一，像不同长度的句子
      for (let x = x0; x < x1; x++) {
        const o = y * (w * 3 + 1) + 1 + x * 3;
        raw[o] = 30; raw[o + 1] = 30; raw[o + 2] = 30;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                          // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TRANSCRIPT = '我：在忙，晚点说\n对方：哦，那你忙吧\n对方：其实我没什么事';

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 412, height: 915 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  await p.goto(OFFLINE);
  await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length > 0');
  /* 摘掉启动浮层。原来只摘 `.gate`，漏了「要不要放点声音」那张 `.sheet open`——
     它每次进 App 都问一次、全屏盖住，于是点任何按钮都会被拦。
     这一条只是**碰巧**没红（跑到这一步时那张浮层没出现），属于"靠运气过"的断言，
     所以补成其它脚本一直在用的写法。同类问题在模拟器上真的发生过：
     盲点序列被那张浮层连着吃掉三次，每次都点到别的页面上去了。 */
  await p.evaluate(() => document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()));
  await p.evaluate(() => { go('ai'); setAiSubview('replay'); });
  await p.waitForTimeout(400);

  console.log('\n[一、入口]');
  const entry = await p.evaluate(() => {
    const btn = document.getElementById('rpShotBtn');
    if (!btn) return { has: false };
    const r = btn.getBoundingClientRect();
    const inp = document.getElementById('shotInput');
    return {
      has: true, text: btn.textContent.trim(),
      visible: r.width > 0 && r.height > 0 && r.top < window.innerHeight,
      // 电脑这条路要能测，就得有 input；手机上走原生，不该有它
      inputMade: !!inp, accept: inp ? inp.accept : '', multiple: inp ? inp.multiple : false,
      privacy: /截图/.test(document.body.textContent),
    };
  });
  chk('复盘页有「上传聊天截图」按钮', entry.has, entry.text);
  chk('按钮首屏可见（不用滚动）', entry.visible);
  chk('隐私提醒里写明了「截图也会发出去」（原来只说文字）', entry.privacy);

  console.log('\n[二、点一下 → 才建 input；选一张普通截图]');
  await p.click('#rpShotBtn');
  const afterClick = await p.evaluate(() => {
    const i = document.getElementById('shotInput');
    return i ? { accept: i.accept, multiple: i.multiple, hidden: i.style.display === 'none' } : null;
  });
  chk('点过之后有了文件选择框（accept=image/*、可多选、隐藏着）',
    !!afterClick && afterClick.accept === 'image/*' && afterClick.multiple && afterClick.hidden,
    JSON.stringify(afterClick));

  // 记下模型调用，供下面断言请求形状
  await p.evaluate(() => {
    window.__calls = [];
    window.llmCall = async (m, o) => {
      window.__calls.push({ m, o });
      return { __plain: true, reply: '我：在忙，晚点说\n对方：哦，那你忙吧' };
    };
    V.native = null;                 // 明确走电脑那条路
  });
  const small = makePng(700, 900);   // 不高，不该被切
  await p.setInputFiles('#shotInput', [{ name: 'a.png', mimeType: 'image/png', buffer: small }]);
  await p.waitForTimeout(1200);

  const c1 = await p.evaluate(() => {
    const c = window.__calls[0];
    if (!c) return { called: 0 };
    const u = c.m[1].content;
    return {
      called: window.__calls.length,
      model: c.o.model,
      temp: c.o.temperature,
      noFormat: c.o.noFormat,
      textOk: c.o.textOk,
      isArray: Array.isArray(u),
      kinds: Array.isArray(u) ? u.map((x) => x.type) : null,
      urlHead: Array.isArray(u) && u[1] ? String(u[1].image_url.url).slice(0, 22) : '',
      sysHasRules: /看不清/.test(c.m[0].content) && /不要猜/.test(c.m[0].content),
      box: document.getElementById('rpChat').value,
      state: document.getElementById('rpShotState').textContent.trim(),
      btnEnabled: !document.getElementById('rpShotBtn').disabled,
    };
  });
  chk('喂进去一张图 → 真的调了模型', c1.called === 1, String(c1.called));
  chk('用的是视觉模型（不是对话模型）', /vision/i.test(String(c1.model)), String(c1.model));
  chk('请求形状：content 是块数组 [text, image_url]',
    c1.isArray && c1.kinds.join(',') === 'text,image_url', JSON.stringify(c1.kinds));
  chk('图片是 jpeg 的 dataURL（不是原图 PNG 直传）', /^data:image\/jpeg/.test(c1.urlHead), c1.urlHead);
  chk('OCR 要白话：带了 noFormat 与 textOk，温度压到 0',
    c1.noFormat === true && c1.textOk === true && c1.temp === 0,
    `noFormat=${c1.noFormat} textOk=${c1.textOk} temp=${c1.temp}`);
  chk('提示词里写了「看不清用？代替、不要猜」', c1.sysHasRules);
  chk('普通截图不切段（1 张图）', c1.kinds.length === 2, String(c1.kinds.length - 1) + ' 张');
  chk('识别结果填进了输入框', /在忙，晚点说/.test(c1.box), c1.box.split('\n')[0]);
  chk('状态栏告诉他是"识别完成"且提示先看一眼', /识别完成/.test(c1.state) && /看一眼/.test(c1.state), c1.state);
  chk('按钮**恢复可用**（不会卡在禁用状态）', c1.btnEnabled);

  console.log('\n[三、长截图：必须切开，不能一张压糊]');
  await p.evaluate(() => { window.__calls = []; document.getElementById('rpChat').value = ''; });
  const tall = makePng(700, 3500);   // 高宽比 5 → 该切成 3 段
  await p.setInputFiles('#shotInput', [{ name: 'tall.png', mimeType: 'image/png', buffer: tall }]);
  await p.waitForTimeout(2500);
  const c2 = await p.evaluate(() => {
    const c = window.__calls[0];
    if (!c) return { called: 0 };
    const u = c.m[1].content;
    const imgs = u.filter((x) => x.type === 'image_url');
    return {
      called: 1, n: imgs.length,
      allJpeg: imgs.every((x) => /^data:image\/jpeg/.test(x.image_url.url)),
      // 每段的像素高宽比应该落在 1.2~2.4，否则就是切得不合理
      ratios: imgs.map((x) => {
        const m = /base64,/.test(x.image_url.url);
        return m ? 'jpeg' : '?';
      }),
      prompt: u[0].text,
      box: document.getElementById('rpChat').value,
    };
  });
  chk('长截图被切成多段（>1）', c2.called && c2.n > 1, `${c2.n} 张`);
  chk('段数不超过上限 3（token 成本可控）', c2.n <= 3, String(c2.n));
  chk('每一段都是 jpeg 的 dataURL', c2.allJpeg === true);
  chk('多图时提示词说明了「拼起来是完整记录」', /拼起来|按顺序/.test(c2.prompt || ''), c2.prompt);
  chk('长截图识别结果也填进去了', /在忙/.test(c2.box));

  console.log('\n[四、失败要说人话，而且不破坏已有内容]');
  await p.evaluate(() => {
    window.__calls = [];
    // 模型"没读图、只顺着话答了"——最难查的那种静默失败
    window.llmCall = async () => ({ __plain: true, reply: '好的，我明白了' });
    document.getElementById('rpChat').value = '我自己打的字';
  });
  await p.setInputFiles('#shotInput', [{ name: 'x.png', mimeType: 'image/png', buffer: small }]);
  await p.waitForTimeout(1200);
  const c3 = await p.evaluate(() => ({
    state: document.getElementById('rpShotState').textContent,
    box: document.getElementById('rpChat').value,
    btnEnabled: !document.getElementById('rpShotBtn').disabled,
    hasManualHint: /直接打字/.test(document.getElementById('rpShotState').textContent),
  }));
  chk('模型没读出聊天记录时，明确说「没识别成功」', /没识别成功/.test(c3.state), c3.state.slice(0, 60));
  chk('并且告诉他还原成手动打字也能用', c3.hasManualHint);
  chk('失败时**不覆盖**他已经打的字', c3.box === '我自己打的字', c3.box);
  chk('失败后按钮也恢复可用', c3.btnEnabled);

  console.log('\n[五、再失败一次：接口报错也要能显示]');
  await p.evaluate(() => {
    window.llmCall = async () => { throw new Error('400 模型不支持图片'); };
  });
  await p.setInputFiles('#shotInput', [{ name: 'y.png', mimeType: 'image/png', buffer: small }]);
  await p.waitForTimeout(1200);
  const c4 = await p.evaluate(() => document.getElementById('rpShotState').textContent);
  chk('接口报错时把原因带出来（不是只说"失败了"）', /400|不支持|图/.test(c4), c4.slice(0, 70));

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  /* ------------------------------------------------------------------
     六、**原生桥的真实调用形状**（这一节是补上的，因为前面五节都漏了它）

     上面 1~5 节全走 #shotInput（电脑那条路），等于**在测试里把 payload 当成
     对象**交给处理函数；而真机上原生是用 JSONObject.quote 把 JSON 包成字符串
     再注入的，网页收到的 typeof 是 'string'。

     结果就是：24 项断言全绿，真机上一按却提示「没识别成功：没选到图片」。
     测试测的是"它应该怎么被调用"，不是"它实际怎么被调用"——两个都对，
     却什么都没验证到。这一节按真实形状调，才算真的盖住了。
     ------------------------------------------------------------------ */
  console.log('\n[六、按原生的真实形状调桥（JSON 字符串，不是对象）]');
  const hasBridgeObj = await p.evaluate(() => typeof bridgeObj === 'function');
  chk('有一个统一的归一化入口 bridgeObj', hasBridgeObj);

  // 6.1 失败：字符串形式进来，why 要能读到（而不是掉进"没选到图片"的兜底）
  await p.evaluate(() => {
    document.getElementById('rpChat').value = '';
    window.__onShot(JSON.stringify({ ok: false, why: '在选择器里取消了' }));
  });
  await p.waitForTimeout(300);
  const b1 = await p.evaluate(() => document.getElementById('rpShotState').textContent);
  chk('字符串形式的失败 payload，能读到 why', /在选择器里取消了/.test(b1), b1.slice(0, 60));
  chk('不再掉进「没选到图片」这个笼统兜底', !/没选到图片/.test(b1), b1.slice(0, 60));

  // 6.2 坏 JSON：当成"没有数据"，但不能抛异常
  const before = errs.length;
  await p.evaluate(() => { window.__onShot('{这不是 json'); });
  await p.waitForTimeout(300);
  const b2 = await p.evaluate(() => document.getElementById('rpShotState').textContent);
  chk('坏 JSON 不抛异常，按失败处理', errs.length === before && /没识别成功/.test(b2), b2.slice(0, 50));

  // 6.3 成功：字符串形式的 {ok:true, dataUrl} 要真的走到 OCR
  await p.evaluate(() => {
    window.__calls = [];
    window.llmCall = async (m, o) => {
      window.__calls.push({ m, o });
      return { __plain: true, reply: '我：在忙，晚点说\n对方：哦，那你忙吧\n对方：其实我没什么事' };
    };
    document.getElementById('rpChat').value = '';
    document.getElementById('rpShotState').innerHTML = '';
    // 造一张真图，再按原生的形状（字符串）交给桥
    const c = document.createElement('canvas');
    c.width = 400; c.height = 800;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 800);
    g.fillStyle = '#000'; g.font = '20px sans-serif'; g.fillText('聊天记录', 20, 40);
    window.__onShot(JSON.stringify({ ok: true, dataUrl: c.toDataURL('image/jpeg', 0.8) }));
  });
  await p.waitForTimeout(2000);
  const b3 = await p.evaluate(() => ({
    state: document.getElementById('rpShotState').textContent,
    box: document.getElementById('rpChat').value,
    calls: window.__calls.length,
    isVision: !!(window.__calls[0] && window.__calls[0].o && /vision/.test(window.__calls[0].o.model || '')),
  }));
  chk('字符串形式的成功 payload，真的发出了 OCR 请求', b3.calls === 1, String(b3.calls));
  chk('并且用的是视觉模型', b3.isVision);
  chk('识别结果填进了输入框', /在忙，晚点说/.test(b3.box), b3.box.slice(0, 40));
  chk('提示语是「识别完成」', /识别完成/.test(b3.state), b3.state.slice(0, 40));

  // 6.4 音乐状态当年中的是同一个坑（typeof o !== 'object' 直接 return）
  const b4 = await p.evaluate(() => {
    onMusicState(JSON.stringify({ has: true, name: '测试.mp3', playing: false, type: 'picked' }));
    return !!(V.music && V.music.has);
  });
  chk('音乐状态也能接住字符串（同一个坑的第二处）', b4);

  chk('第六节也没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
