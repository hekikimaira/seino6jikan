/* =========================================================
   game.js（全部置き換え用 / 1ファイル完結）
   - window.bootGame({ packsRoot, scenario, saveKeyPrefix }) を生やす
   - packs/<scenario>/text.js と packs/<scenario>/scenario.js を動的ロード
   - キーボード操作（←→ / A D）で文字送り対応
   - ★追加：SE / Voice 再生 + iOS/Android 自動再生ブロック対策
   ========================================================= */

/* =========================================================
   ① CONFIG（config.js が無ければデフォルト）
   ========================================================= */
const DEFAULT_CONFIG = {
	scenario: "umae",
	packsRoot: "packs",
	saveKeyPrefix: "umae_",
	saveSlots: 10,
	
	volumeMaster: 1.0,
	volumeBgm: 0.6,
	volumeRse: 0.25,
	volumeSe: 0.12,
	volumeVoice: 1.0,
};

// ★追加：実際に使う設定（config.js の window.GAME_CONFIG をマージ）
let CONFIG = { ...DEFAULT_CONFIG, ...(window.GAME_CONFIG ?? {}) };

/* ====================================
   ② ユーティリティ
   ==================================== */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function clamp01(x) {
	x = Number(x);
	if (Number.isNaN(x)) return 0;
	return Math.max(0, Math.min(1, x));
}

function vol(v) {
	return clamp01(CONFIG.volumeMaster ?? 1) * clamp01(v ?? 1);
}

function loadScript(src) {
	return new Promise((resolve, reject) => {
			const s = document.createElement("script");
			s.src = src;
			s.async = true;
			s.onload = () => resolve();
			s.onerror = () => reject(new Error("load failed: " + src));
			document.head.appendChild(s);
	});
}

function packPath(rel) {
	if (rel === null || rel === undefined) return "";
	const s = String(rel);
	
	if (/^(https?:)?\/\//.test(s)) return s;
	if (s.startsWith("/")) return s;
	
	// "../common/xxx" → packs/common/xxx
	if (s.startsWith("../")) {
		return `${CONFIG.packsRoot}/${s.replace(/^\.\.\//, "")}`;
	}
	
	// "img/001.png" → packs/<scenario>/img/001.png
	return `${CONFIG.packsRoot}/${CONFIG.scenario}/${s}`;
}

/* ====================================
   ③ セーブ/ロード（最低限）
   ==================================== */
function saveKey(slot) {
	const p = CONFIG.saveKeyPrefix || (CONFIG.scenario + "_");
	return `${p}save_${slot}`;
}

function safeJsonParse(s) {
	try { return JSON.parse(s); } catch { return null; }
}

/* ====================================
   ④ グローバル状態
   ==================================== */
let FLAGS = {};
let index = 0;
let pageIndex = 0;
let pages = [""];
let ended = false;

let SCENES = [];
let TEXTS = {};

let currentImg = "";

/* =========================================================
   ⑤ 起動口（game.html から呼ばれる）
   ========================================================= */
window.bootGame = async function bootGame(opts = {}) {
	try {
		const root = opts.packsRoot ?? CONFIG.packsRoot;
		const scn  = opts.scenario  ?? CONFIG.scenario;
		
		CONFIG.packsRoot = root;
		CONFIG.scenario  = scn;
		
		if (opts.saveKeyPrefix !== undefined) {
			CONFIG.saveKeyPrefix = opts.saveKeyPrefix;
		}
		
		// text.js は任意（無いなら警告して続行）
		try {
			await loadScript(`${root}/${scn}/text.js`);
		} catch (e) {
			console.warn("text.js が見つからない/読めないのでスキップ:", `${root}/${scn}/text.js`, e);
		}
		
		// scenario.js は必須
		await loadScript(`${root}/${scn}/scenario.js`);
		
		if (!Array.isArray(window.SCENES) || window.SCENES.length === 0) {
			alert(
				"SCENES が読み込めてない：scenario.js を確認\n\n" +
				`読みに行った: ${root}/${scn}/scenario.js\n` +
				"・そのファイルが存在するか\n" +
				"・window.SCENES = [...] になってるか\n"
			);
			return;
		}
		
		SCENES = window.SCENES;
		TEXTS  = window.TEXTS || window.TEXT || {};
		
		startGame();
	} catch (e) {
		alert("bootGame 失敗: " + (e?.message ?? String(e)));
		console.error(e);
	}
};

/* =========================================================
   ⑥ 本体
   ========================================================= */
function startGame() {
	// 要素取得
	const img = document.getElementById("sceneImage");
	const fade = document.getElementById("fadeLayer");
	const startButton = document.getElementById("startButton");
	
	// ★HTML側の実在idにフォールバック
	const backButton =
	document.getElementById("backButton") ||
	document.getElementById("prevButton");
	
	const nextArea =
	document.getElementById("nextArea") ||
	document.getElementById("nextButton");
	
	// ★debug は任意（無ければ何もしない）
	const debug = document.getElementById("debug");
	
	const bgm = document.getElementById("bgm");
	const rse = document.getElementById("rse");
	
	// ★追加：SE / VOICE
	const se = document.getElementById("se");
	const voice = document.getElementById("voice");
	
	const nameBox = document.getElementById("nameBox");
	const textBox = document.getElementById("textBox");
	
	// セーフガード（必須だけチェック）
	const missing = [];
	if (!img) missing.push("sceneImage");
	if (!fade) missing.push("fadeLayer");
	if (!startButton) missing.push("startButton");
	if (!backButton) missing.push("prevButton(or backButton)");
	if (!nextArea) missing.push("nextButton(or nextArea)");
	if (!bgm) missing.push("bgm");
	if (!rse) missing.push("rse");
	if (!nameBox) missing.push("nameBox");
	if (!textBox) missing.push("textBox");
	if (missing.length) {
		alert("HTML側の id が足りない: " + missing.join(", "));
		return;
	}
	
	/* =========================================================
	 ⑥-1 音量初期化
	 ========================================================= */
	bgm.volume = vol(CONFIG.volumeBgm ?? 0.6);
	rse.volume = vol(CONFIG.volumeRse ?? 0.25);
	if (se) se.volume = vol(CONFIG.volumeSe ?? 0.12);
	if (voice) voice.volume = vol(CONFIG.volumeVoice ?? 1.0);
	
	/* =========================================================
	 ⑥-2 iOS/Androidの自動再生ブロック解除（開始ボタンで実行）
	 ========================================================= */
	function unlockAudio(el) {
		if (!el) return;
		try {
			const prevVol = el.volume;
			el.volume = 0;
			const p = el.play();
			if (p && typeof p.then === "function") {
				p.then(() => {
						el.pause();
						el.currentTime = 0;
						el.volume = prevVol;
				}).catch(() => {
						// 解除できない場合もあるが黙って進む
						el.volume = prevVol;
				});
			} else {
				// 古い環境向け
				el.pause();
				el.currentTime = 0;
				el.volume = prevVol;
			}
		} catch {}
	}
	
	/* =========================================================
	 ⑥-3 テキスト
	 ========================================================= */
	function splitPages(text) {
		const s = String(text ?? "");
		// \n\n をページ区切りにする（好みで変更OK）
		return s.split(/\n\s*\n/g).map(x => x.trim()).filter(Boolean);
	}
	
	function applyNameAndText(name, pageText) {
		nameBox.textContent = name ?? "";
		textBox.textContent = pageText ?? "";
	}
	
	/* =========================================================
	 ⑥-4 音声再生（BGM/RSE/SE/VOICE）
	 ========================================================= */
	function playAudio(el, path, volume) {
		if (!el) return;
		if (!path) return;
		
		try { el.pause(); } catch {}
		try { el.currentTime = 0; } catch {}
		
		el.src = packPath(path);
		el.volume = vol(volume);
		
		el.play().catch((e) => {
				// ここに来るのは多くが自動再生ブロック or 404
				console.warn("audio play failed:", el.id, el.src, e?.message ?? e);
		});
	}
	
	function stopAudio(el) {
		if (!el) return;
		try { el.pause(); } catch {}
		try { el.currentTime = 0; } catch {}
	}
	
	// ★SE専用：多重クリックでも鳴るように clone 再生（短いSE向け）
	// ①使いたくないなら false にする
	const SE_CLONE_MODE = true;
	
	function playSE(path) {
		if (!path) return;
		const src = packPath(path);
		
		if (!se) {
			console.warn("audio#se が無いのでSE再生できない:", src);
			return;
		}
		
		if (SE_CLONE_MODE) {
			try {
				const a = se.cloneNode(true);
				a.src = src;
				a.volume = vol(CONFIG.volumeSe ?? 0.12);
				a.play().catch((e) => console.warn("SE clone play failed:", src, e?.message ?? e));
				a.addEventListener("ended", () => {
						try { a.src = ""; } catch {}
				});
			} catch (e) {
				console.warn("SE clone mode failed; fallback to single:", e);
				// フォールバック
				playAudio(se, path, CONFIG.volumeSe ?? 0.12);
			}
			return;
		}
		
		// ②通常モード
		playAudio(se, path, CONFIG.volumeSe ?? 0.12);
	}
	
	function playVoice(path) {
		if (!path) return;
		if (!voice) {
			console.warn("audio#voice が無いのでvoice再生できない:", path);
			return;
		}
		playAudio(voice, path, CONFIG.volumeVoice ?? 1.0);
	}
	
	/* =========================================================
	 ⑥-5 入力
	 ========================================================= */
	// 読み込み開始
	startButton.addEventListener("click", () => {
			// ★ブロック解除（ここが無いとスマホでSEが鳴らないことがある）
			unlockAudio(bgm);
			unlockAudio(rse);
			unlockAudio(se);
			unlockAudio(voice);
			
			startButton.style.display = "none";
			renderScene(index, { showLastPage: false });
	});
	
	// 進む（クリック/タップ）
	nextArea.addEventListener("click", () => advance());
	
	// 戻る
	backButton.addEventListener("click", () => back());
	
	// キーボード（→/D 進む、←/A 戻る）
	window.addEventListener("keydown", (e) => {
			const k = e.key;
			if (k === "ArrowRight" || k === "d" || k === "D") {
				e.preventDefault();
				advance();
			}
			if (k === "ArrowLeft" || k === "a" || k === "A") {
				e.preventDefault();
				back();
			}
	});
	
	/* =========================================================
	 ⑥-6 シーン描画
	 ========================================================= */
	
	// ③ フラッシュ演出（fadeLayerを流用）
	async function runFx(fx) {
		if (!fx) return;
		
		if (fx.type === "flash") {
			const delay = Number(fx.delay ?? 0);
			const color = String(fx.color ?? "#fff");
			const tIn = Number(fx.in ?? 120);
			const hold = Number(fx.hold ?? 60);
			const tOut = Number(fx.out ?? 200);
			
			// fadeLayerを白フラッシュに転用
			fade.style.transition = "none";
			fade.style.background = color;
			fade.style.opacity = 0;
			
			if (delay > 0) await sleep(delay);
			
			// IN
			fade.style.transition = `opacity ${tIn}ms linear`;
			fade.style.opacity = 1;
			await sleep(tIn + hold);
			
			// OUT
			fade.style.transition = `opacity ${tOut}ms linear`;
			fade.style.opacity = 0;
			await sleep(tOut);
			
			// 復帰
			fade.style.transition = "";
			fade.style.background = "black";
		}
	}
	
	function evalIf(cond) {
		// cond 例:
		// { flag: "x", op: ">=", value: 2 }
		// { not: { ... } }
		// { and: [ ... ] } / { or: [ ... ] }
		if (!cond) return true;
		
		if (cond.not) return !evalIf(cond.not);
		if (Array.isArray(cond.and)) return cond.and.every(evalIf);
		if (Array.isArray(cond.or)) return cond.or.some(evalIf);
		
		const flag = cond.flag;
		const op = cond.op || "==";
		const value = cond.value;
		
		const a = FLAGS[flag];
		const b = value;
		
		switch (op) {
			case "==": return a == b;
			case "!=": return a != b;
			case ">": return Number(a) > Number(b);
			case ">=": return Number(a) >= Number(b);
			case "<": return Number(a) < Number(b);
			case "<=": return Number(a) <= Number(b);
			default: return !!a;
		}
	}
	
	async function renderScene(i, { showLastPage }) {
		const scene = SCENES[i];
		if (!scene) return;
		
		// 条件分岐
		if (scene.if) {
			const ok = evalIf(scene.if);
			if (!ok) {
				index = i + 1;
				return renderScene(index, { showLastPage: false });
			}
		}
		
		// set（フラグ更新）
		if (scene.set && typeof scene.set === "object") {
			for (const [k, v] of Object.entries(scene.set)) {
				if (typeof v === "number") {
					FLAGS[k] = (Number(FLAGS[k]) || 0) + v;
				} else {
					FLAGS[k] = v;
				}
			}
		}
		
		// ★任意：シーン開始ディレイ（今までの scene.delay を生かす）
		// ④ delayを「音の前」に入れたいならここが効く
		const sceneDelay = Number(scene.delay ?? 0);
		if (sceneDelay > 0) await sleep(sceneDelay);
		
		// fade
		const doFade = !!scene.fade;
		if (doFade) {
			fade.style.opacity = 1;
			await sleep(200);
		} else {
			fade.style.opacity = 0;
		}
		
		index = i;
		ended = false;
		
		// 画像
		if (scene.img !== null && scene.img !== undefined) {
			const resolved = packPath(scene.img);
			if (resolved && resolved !== currentImg) {
				img.src = resolved;
				currentImg = resolved;
			}
		}
		
		// 音（BGM/RSE）
		if (scene.bgm === null) stopAudio(bgm);
		if (scene.rse === null) stopAudio(rse);
		if (scene.bgm) playAudio(bgm, scene.bgm, CONFIG.volumeBgm ?? 0.6);
		if (scene.rse) playAudio(rse, scene.rse, CONFIG.volumeRse ?? 0.25);
		
		// ★追加：SE/VOICE
		// ⑤ seDelay を用意（無ければ 0）。delay と分けて扱えるようにする
		const seDelay = Number(scene.seDelay ?? 0);
		if (scene.se === null) stopAudio(se);      // 明示停止
		if (scene.voice === null) stopAudio(voice); // 明示停止
		
		if (scene.se) {
			if (seDelay > 0) setTimeout(() => playSE(scene.se), seDelay);
			else playSE(scene.se);
		}
		if (scene.voice) {
			// voiceも遅らせたければ voiceDelay を使う
			const vd = Number(scene.voiceDelay ?? 0);
			if (vd > 0) setTimeout(() => playVoice(scene.voice), vd);
			else playVoice(scene.voice);
		}
		
		// テキスト（text 直書き優先、無ければ textId）
		const rawText = (scene.text ?? TEXTS[scene.textId] ?? "");
		pages = splitPages(rawText);
		if (pages.length === 0) pages = [""];
		pageIndex = showLastPage ? Math.max(0, pages.length - 1) : 0;
		
		applyNameAndText(scene.name ?? "", pages[pageIndex]);
		
		// fx
		await runFx(scene.fx);
		
		if (doFade) {
			await sleep(120);
			fade.style.opacity = 0;
		}
		
		// デバッグ
		if (debug) {
			debug.textContent =
			`scene: ${scene.id || "(no id)"}\n` +
			`index: ${index}\n` +
			`page: ${pageIndex + 1}/${pages.length}\n` +
			`flags: ${JSON.stringify(FLAGS)}`;
		}
	}
	
	function advance() {
		// ページ送り
		if (pageIndex < pages.length - 1) {
			pageIndex++;
			applyNameAndText(SCENES[index]?.name ?? "", pages[pageIndex]);
			return;
		}
		
		// シーン送り
		const next = index + 1;
		if (next >= SCENES.length) {
			ended = true;
			return;
		}
		renderScene(next, { showLastPage: false });
	}
	
	function back() {
		// ページ戻し
		if (pageIndex > 0) {
			pageIndex--;
			applyNameAndText(SCENES[index]?.name ?? "", pages[pageIndex]);
			return;
		}
		
		// シーン戻し
		const prev = index - 1;
		if (prev < 0) return;
		renderScene(prev, { showLastPage: true });
	}
}
