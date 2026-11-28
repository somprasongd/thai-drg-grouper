// Thai DRG Grouper web UI. Plain JavaScript, no build step, no outside files.
// Every text from the server or the user goes in with textContent (never innerHTML).
'use strict';

(() => {
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
    const nf = (n, d = 4) => (n === null || n === undefined || Number.isNaN(n) ? '–' : Number(n).toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d }));
    const int = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('th-TH'));

    /** h('div', {class: 'x'}, 'text', child) */
    function h(tag, attrs = {}, ...kids) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const kid of kids.flat()) {
            if (kid === null || kid === undefined || kid === false) continue;
            el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
        }
        return el;
    }

    /** replaceChildren that skips null, undefined and false (they would show as text) */
    const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

    // Thai text for the grouper's codes (the API gives English for errors)
    const ERRORS_TH = {
        1: 'ไม่มีการวินิจฉัยหลัก (PDx)',
        2: 'รหัสการวินิจฉัยหลักไม่ถูกต้อง',
        3: 'รหัสนี้ใช้เป็นการวินิจฉัยหลักไม่ได้',
        4: 'การวินิจฉัยหลักไม่เหมาะกับอายุ',
        5: 'การวินิจฉัยหลักไม่เหมาะกับเพศ',
        6: 'อายุผิดพลาด',
        7: 'จัดกลุ่มไม่ได้ เพราะข้อมูลเพศผิดพลาด',
        8: 'จัดกลุ่มไม่ได้ เพราะประเภทการจำหน่ายผิดพลาด',
        9: 'วันนอนโรงพยาบาลผิดพลาด',
        10: 'จัดกลุ่มไม่ได้ เพราะน้ำหนักแรกรับผิดพลาด',
    };

    // ------------------------------------------------------------------ API
    const KEY_STORE = 'thai-drg-grouper.apiKey';
    const state = { version: null, keyNeeded: false };

    class AuthError extends Error {}

    async function api(path, opts = {}) {
        const headers = new Headers(opts.headers || {});
        const key = sessionStorage.getItem(KEY_STORE);
        if (key) headers.set('X-API-Key', key);
        const res = await fetch(path, { ...opts, headers, cache: 'no-store' });
        if (res.status === 401) {
            state.keyNeeded = true;
            $('#key-open').hidden = false;
            throw new AuthError('ต้องใส่คีย์ API');
        }
        return res;
    }

    async function apiJson(path, opts) {
        const res = await api(path, opts);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const e = new Error(body.message || `HTTP ${res.status}`);
            e.problems = body.problems;
            e.status = res.status;
            throw e;
        }
        return body;
    }

    const withVersion = (path) => (state.version ? `${path}?version=${encodeURIComponent(state.version)}` : path);

    // ------------------------------------------------------------------ API key dialog
    const keyDialog = $('#key-dialog');
    function openKeyDialog(message) {
        $('#key-input').value = sessionStorage.getItem(KEY_STORE) || '';
        const err = $('#key-error');
        err.hidden = !message;
        err.textContent = message || '';
        keyDialog.showModal();
    }
    $('#key-open').addEventListener('click', () => openKeyDialog());
    keyDialog.addEventListener('close', () => {
        if (keyDialog.returnValue !== 'save') return;
        const v = $('#key-input').value.trim();
        if (v) sessionStorage.setItem(KEY_STORE, v);
        else sessionStorage.removeItem(KEY_STORE);
        loadVersions();
    });

    function handleAuth(e) {
        if (e instanceof AuthError) {
            openKeyDialog(sessionStorage.getItem(KEY_STORE) ? 'คีย์ไม่ถูกต้อง ลองใหม่อีกครั้ง' : '');
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ versions
    async function loadVersions() {
        try {
            const v = await apiJson('/api/v1/versions');
            const sel = $('#version');
            sel.replaceChildren(...v.versions.map((x) => h('option', { value: x.version, selected: x.version === v.default }, x.name || x.version)));
            state.version = state.version && v.versions.some((x) => x.version === state.version) ? state.version : v.default;
            sel.value = state.version;
            $('#version-pick').hidden = v.versions.length < 2;
            const label = v.versions.find((x) => x.version === state.version);
            $('#brand-version').textContent = `${label?.name || `Thai DRG ${state.version}`} · ${int(label?.drgCount)} DRG`;
            $('#foot-version').textContent = `grouper ${state.version}`;
        } catch (e) {
            if (!handleAuth(e)) $('#brand-version').textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';
            else $('#brand-version').textContent = 'ต้องใส่คีย์ API';
        }
    }
    $('#version').addEventListener('change', (e) => { state.version = e.target.value; });

    // ------------------------------------------------------------------ tabs
    const tabs = $$('[role="tab"]');
    function selectTab(tab) {
        for (const t of tabs) {
            const on = t === tab;
            t.setAttribute('aria-selected', String(on));
            t.tabIndex = on ? 0 : -1;
            $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
        }
        history.replaceState(null, '', tab.id === 'tab-file' ? '#file' : '#form');
    }
    tabs.forEach((t, i) => {
        t.addEventListener('click', () => selectTab(t));
        t.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            selectTab(next);
            next.focus();
        });
    });
    if (location.hash === '#file') selectTab($('#tab-file'));

    // ------------------------------------------------------------------ code chips
    class Chips {
        constructor(box) {
            this.box = box;
            this.input = $('input', box);
            this.max = Number(box.dataset.max);
            this.pattern = new RegExp(box.dataset.pattern);
            this.codes = [];
            box.addEventListener('click', (e) => { if (e.target === box) this.input.focus(); });
            this.input.addEventListener('keydown', (e) => {
                if (['Enter', ',', ' ', ';', 'Tab'].includes(e.key) && this.input.value.trim()) {
                    if (e.key !== 'Tab') e.preventDefault();
                    this.addText(this.input.value);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                } else if (e.key === 'Backspace' && this.input.value === '' && this.codes.length) {
                    this.remove(this.codes.length - 1);
                }
            });
            this.input.addEventListener('paste', (e) => {
                const text = e.clipboardData?.getData('text');
                if (text && /[\s,;]/.test(text.trim())) {
                    e.preventDefault();
                    this.addText(text);
                }
            });
            this.input.addEventListener('blur', () => { if (this.input.value.trim()) this.addText(this.input.value); });
        }

        addText(text) {
            for (const raw of text.split(/[\s,;]+/)) {
                const code = raw.trim().toUpperCase();
                if (!code || this.codes.length >= this.max) continue;
                this.codes.push(code);
            }
            this.input.value = '';
            this.render();
        }

        remove(i) {
            this.codes.splice(i, 1);
            this.render();
            this.input.focus();
        }

        set(list) {
            this.codes = list.slice(0, this.max);
            this.render();
        }

        render() {
            $$('.chip', this.box).forEach((c) => c.remove());
            this.codes.forEach((code, i) => {
                const bad = !this.pattern.test(code);
                this.box.insertBefore(h('span', { class: bad ? 'chip bad' : 'chip', title: bad ? 'รูปแบบรหัสไม่ถูกต้อง' : null },
                    h('span', { class: 'n' }, i + 1), code,
                    h('button', { type: 'button', 'aria-label': `ลบ ${code}`, onclick: () => this.remove(i) }, '×')), this.input);
            });
            this.box.classList.toggle('chips-full', this.codes.length >= this.max);
            this.input.placeholder = this.codes.length ? '' : 'พิมพ์รหัสแล้วกด Enter';
        }
    }
    const chips = Object.fromEntries($$('.chips').map((b) => [b.dataset.name, new Chips(b)]));

    // ------------------------------------------------------------------ form
    const form = $('#case-form');
    const val = (name) => form.elements[name].value.trim();

    function daysBetween(a, b) {
        return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
    }

    function ageOn(dob, on) {
        const [by, bm, bd] = dob.split('-').map(Number);
        const [ay, am, ad] = on.split('-').map(Number);
        const at = Date.UTC(ay, am - 1, ad);
        if (at < Date.UTC(by, bm - 1, bd)) return null;
        let years = ay - by;
        let last = Date.UTC(by + years, bm - 1, bd);
        if (last > at) { years -= 1; last = Date.UTC(by + years, bm - 1, bd); }
        return { years, days: Math.round((at - last) / 86400000) };
    }

    function updateHints() {
        const dob = val('dob');
        const adm = val('admitDate');
        const dsc = val('dischargeDate');
        const ageOut = $('#age-out');
        ageOut.replaceChildren();
        if (dob && adm) {
            const a = ageOn(dob, adm);
            if (a) ageOut.append('อายุวันที่รับไว้ ', h('strong', {}, `${a.years} ปี ${a.days} วัน`));
            else ageOut.append('วันเกิดอยู่หลังวันที่รับไว้');
        }
        const losOut = $('#los-out');
        losOut.replaceChildren();
        if (adm && dsc) {
            const d = daysBetween(adm, dsc);
            if (d < 0) losOut.append('วันที่จำหน่ายอยู่ก่อนวันที่รับไว้');
            else losOut.append('ห่างกัน ', h('strong', {}, `${d} วัน`), ' (grouper คิดวันนอนจากวันและเวลา)');
        }
    }
    form.addEventListener('input', updateHints);
    form.addEventListener('change', updateHints);

    function readCase() {
        const c = {};
        const sex = form.elements.sex.value;
        if (sex) c.sex = sex;
        const put = (key, v) => { if (v !== '') c[key] = v; };
        put('dob', val('dob'));
        put('admitDate', val('admitDate'));
        put('admitTime', val('admitTime'));
        put('dischargeDate', val('dischargeDate'));
        put('dischargeTime', val('dischargeTime'));
        put('dischargeType', val('dischargeType'));
        put('admitWeight', val('admitWeight'));
        put('leaveDays', val('leaveDays'));
        put('pdx', val('pdx').toUpperCase());
        for (const box of Object.values(chips)) if (box.input.value.trim()) box.addText(box.input.value);
        if (chips.sdx.codes.length) c.sdx = chips.sdx.codes;
        if (chips.procedures.codes.length) c.procedures = chips.procedures.codes;
        return c;
    }

    function busy(btn, on, label) {
        btn.disabled = on;
        if (on) {
            btn.dataset.label = btn.textContent;
            btn.replaceChildren(h('span', { class: 'spin', 'aria-hidden': 'true' }), label);
        } else if (btn.dataset.label) {
            btn.textContent = btn.dataset.label;
        }
    }

    const resultBox = $('#result');

    function showProblems(title, list) {
        fill(resultBox,
            h('div', { class: 'res-head' }, h('div', {}, h('div', { class: 'res-kicker' }, 'ยังจัดกลุ่มไม่ได้'), h('p', { class: 'res-name' }, title))),
            list?.length ? h('ul', { class: 'msgs err' }, list.map((p) => h('li', {}, p))) : null,
        );
    }

    function showResult(r) {
        const ok = !r.errorCode;
        const status = ok
            ? (r.warnings.length ? h('span', { class: 'badge warn' }, `คำเตือน ${r.warnings.length}`) : h('span', { class: 'badge ok' }, 'สำเร็จ'))
            : h('span', { class: 'badge err' }, `Error ${r.errorCode}`);
        const stat = (label, value, hl) => h('div', { class: hl ? 'stat hl' : 'stat' }, h('dt', {}, label), h('dd', {}, value));
        fill(resultBox,
            h('div', { class: 'res-head' },
                h('div', {}, h('div', { class: 'res-kicker' }, 'DRG'), h('div', { class: 'res-drg' }, r.drg || '–')),
                status),
            h('p', { class: 'res-name' }, r.drgName || ''),
            h('p', { class: 'res-sub' }, `MDC ${r.mdc || '–'}`, r.dc ? ` · DC ${r.dc}` : '', r.pcl !== null && r.pcl !== undefined ? ` · PCL ${r.pcl}` : ''),
            h('dl', { class: 'stats' },
                stat('AdjRW', nf(r.adjrw), true),
                stat('RW', nf(r.rw)),
                stat('วันนอน (LOS)', r.los === null ? '–' : int(r.los)),
                stat('WtLOS', nf(r.wtlos, 2)),
                stat('OT', int(r.ot)),
                stat('อายุ', r.age === null ? '–' : `${r.age} ปี`)),
            r.error ? h('ul', { class: 'msgs err' }, h('li', {}, h('span', { class: 'code' }, `Error ${r.error.code}`), ERRORS_TH[r.error.code] || r.error.message, h('small', {}, r.error.message))) : null,
            r.warnings.length ? h('ul', { class: 'msgs warn' }, r.warnings.map((w) => h('li', {}, h('span', { class: 'code' }, w.code), w.message))) : null,
            r.notes?.length ? h('ul', { class: 'msgs note' }, r.notes.map((n) => h('li', {}, n))) : null,
            h('details', { class: 'details' },
                h('summary', {}, 'รายละเอียด'),
                h('dl', {},
                    h('dt', {}, 'รุ่น'), h('dd', {}, r.version),
                    h('dt', {}, 'PDx ที่ใช้'), h('dd', {}, r.pdxUsed || '–'),
                    h('dt', {}, 'อายุ (วัน)'), h('dd', {}, r.ageDay ?? '–'),
                    h('dt', {}, 'Error code'), h('dd', {}, r.errorCode),
                    h('dt', {}, 'Warning code'), h('dd', {}, r.warningCode))),
            h('div', { class: 'res-actions' },
                h('button', { type: 'button', class: 'btn small', onclick: (e) => copy(e.currentTarget, JSON.stringify(r, null, 2)) }, 'คัดลอก JSON')),
        );
        if (window.matchMedia('(max-width: 880px)').matches) resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function copy(btn, text) {
        try {
            await navigator.clipboard.writeText(text);
            btn.textContent = 'คัดลอกแล้ว';
        } catch {
            btn.textContent = 'คัดลอกไม่ได้';
        }
        setTimeout(() => { btn.textContent = 'คัดลอก JSON'; }, 1500);
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#group-btn');
        const body = readCase();
        if (!body.pdx) {
            form.elements.pdx.setAttribute('aria-invalid', 'true');
            form.elements.pdx.focus();
            showProblems('ต้องใส่การวินิจฉัยหลัก (PDx)', []);
            return;
        }
        form.elements.pdx.removeAttribute('aria-invalid');
        busy(btn, true, 'กำลังจัดกลุ่ม…');
        try {
            const r = await apiJson(withVersion('/api/v1/group'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            showResult(r);
        } catch (err) {
            if (!handleAuth(err)) showProblems(err.status === 400 ? 'ข้อมูลไม่ถูกต้อง' : err.message, err.problems || (err.status === 400 ? [err.message] : []));
        } finally {
            busy(btn, false);
        }
    });

    form.addEventListener('reset', () => {
        setTimeout(() => {
            Object.values(chips).forEach((c) => c.set([]));
            form.elements.pdx.removeAttribute('aria-invalid');
            updateHints();
            fill(resultBox, h('div', { class: 'empty' }, h('p', {}, 'กรอกข้อมูลแล้วกด ', h('strong', {}, 'จัดกลุ่ม'), h('br'), 'ผลจะแสดงที่นี่')));
        });
    });

    $('#sample-btn').addEventListener('click', () => {
        const sample = {
            dob: '1980-05-10', admitDate: '2024-01-10', admitTime: '08:30', dischargeDate: '2024-01-13', dischargeTime: '10:00',
            dischargeType: '1', admitWeight: '', leaveDays: '', pdx: 'K35.8',
        };
        for (const [k, v] of Object.entries(sample)) form.elements[k].value = v;
        form.elements.sex.value = '1';
        chips.sdx.set([]);
        chips.procedures.set(['47.09']);
        updateHints();
    });

    // ------------------------------------------------------------------ file
    const fileInput = $('#file-input');
    const drop = $('#drop');
    const fileBtn = $('#file-btn');
    const fileResult = $('#file-result');
    let picked = null;
    let downloadUrl = null;
    const MAX_BYTES = 50 * 1024 * 1024;

    const size = (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

    async function pick(file) {
        picked = null;
        fileBtn.disabled = true;
        fileResult.hidden = true;
        if (!file) return;
        $('#file-name').textContent = file.name;
        $('#file-picked').hidden = false;
        drop.hidden = true;
        if (/\.xls$/i.test(file.name)) {
            $('#file-meta').textContent = 'ไฟล์ .xls รุ่นเก่า ให้บันทึกเป็น .xlsx หรือ .csv ก่อน';
            return;
        }
        if (!/\.(dbf|csv|xlsx|json)$/i.test(file.name)) {
            $('#file-meta').textContent = 'ต้องเป็นไฟล์ .dbf, .csv, .xlsx หรือ .json';
            return;
        }
        if (file.size > MAX_BYTES) {
            $('#file-meta').textContent = `${size(file.size)} ใหญ่เกิน 50 MB`;
            return;
        }
        // a .dbf has the record count in its header: bytes 4-7
        let count = null;
        if (/\.dbf$/i.test(file.name)) {
            const head = new DataView(await file.slice(0, 32).arrayBuffer());
            count = head.byteLength >= 8 ? head.getUint32(4, true) : null;
        }
        $('#file-meta').textContent = `${size(file.size)}${count !== null ? ` · ${int(count)} รายการ` : ''}`;
        picked = file;
        fileBtn.disabled = false;
    }

    fileInput.addEventListener('change', () => pick(fileInput.files[0]));
    $('#file-clear').addEventListener('click', () => {
        fileInput.value = '';
        $('#file-picked').hidden = true;
        drop.hidden = false;
        pick(null);
        fileInput.focus();
    });
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) pick(f);
    });

    function showFileError(message) {
        fileResult.hidden = false;
        fill(fileResult, h('h2', {}, 'จัดกลุ่มไฟล์ไม่ได้'), h('ul', { class: 'msgs err' }, h('li', {}, message)));
    }

    function showFileResult(summary, blob, name) {
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = URL.createObjectURL(blob);
        const ext = summary.format || (/\.(\w+)$/.exec(name)?.[1] ?? 'dbf').toLowerCase();
        const outName = `${name.replace(/\.\w+$/, '')}_drg.${ext}`;
        const tabular = ext === 'csv' || ext === 'xlsx';
        const notes = [];
        if (summary.sheet) notes.push(`ใช้ชีต "${summary.sheet}"`);
        if (ext === 'dbf' && summary.addedFields?.length) notes.push(`ไฟล์ไม่มีคอลัมน์ ${summary.addedFields.join(', ')} จึงเพิ่มไว้ท้ายแต่ละรายการ`);
        if (tabular && summary.addedFields?.length) notes.push(`เพิ่มคอลัมน์ ${summary.addedFields.join(', ')} ต่อจากคอลัมน์สุดท้าย`);
        if (ext === 'json') notes.push('แต่ละรายการได้ฟิลด์ result');
        if (summary.skipped) notes.push(`ข้าม ${int(summary.skipped)} ${ext === 'json' ? 'รายการที่ไม่ใช่ object' : 'แถวว่าง'}`);
        const tile = (label, value, hl) => h('div', { class: hl ? 'stat hl' : 'stat' }, h('dt', {}, label), h('dd', {}, value));
        const errs = Object.entries(summary.errors || {}).sort((a, b) => b[1] - a[1]);
        fileResult.hidden = false;
        fill(fileResult,
            h('div', { class: 'res-head' },
                h('div', {}, h('div', { class: 'res-kicker' }, 'ผลการจัดกลุ่ม'), h('h2', {}, name)),
                summary.withError ? h('span', { class: 'badge warn' }, `Error ${int(summary.withError)} ราย`) : h('span', { class: 'badge ok' }, 'สำเร็จ')),
            h('dl', { class: 'tiles' },
                tile('จัดกลุ่มแล้ว', int(summary.grouped), true),
                tile('มี Error', int(summary.withError)),
                tile('มีคำเตือน', int(summary.withWarning)),
                tile('รวม AdjRW', nf(summary.sumAdjRw)),
                tile('CMI', nf(summary.cmi)),
                ext === 'dbf' ? tile('ถูกลบ (ข้าม)', int(summary.deleted)) : tile('ข้อมูลไม่ถูกต้อง', int(summary.rejected))),
            errs.length ? h('table', { class: 'tbl' },
                h('thead', {}, h('tr', {}, h('th', {}, 'Error'), h('th', {}, 'ความหมาย'), h('th', { class: 'num' }, 'ราย'))),
                h('tbody', {}, errs.map(([code, n]) => h('tr', {}, h('td', { class: 'num' }, code), h('td', {}, ERRORS_TH[code] || ''), h('td', { class: 'num' }, int(n)))))) : null,
            summary.rejected ? h('ul', { class: 'msgs warn' }, h('li', {}, `${int(summary.rejected)} รายการมีข้อมูลไม่ถูกต้องจึงไม่ได้จัดกลุ่ม ดูเหตุผลที่${ext === 'json' ? ' result.inputErrors' : 'คอลัมน์ GRPNOTE'}`)) : null,
            notes.length ? h('ul', { class: 'msgs note' }, notes.map((n) => h('li', {}, n))) : null,
            summary.overflow ? h('ul', { class: 'msgs warn' }, h('li', {}, `${int(summary.overflow)} ค่าไม่พอกับความกว้างของคอลัมน์ในไฟล์ จึงใส่ * แทน`)) : null,
            h('a', { class: 'btn primary download', href: downloadUrl, download: outName }, `ดาวน์โหลด ${outName}`),
        );
    }

    fileBtn.addEventListener('click', async () => {
        if (!picked) return;
        const file = picked;
        busy(fileBtn, true, 'กำลังจัดกลุ่ม…');
        try {
            const res = await api(withVersion('/api/v1/group/file'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: file,
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                showFileError(body.message || `HTTP ${res.status}`);
                return;
            }
            const summary = JSON.parse(res.headers.get('x-grouper-summary') || '{}');
            showFileResult(summary, await res.blob(), file.name);
        } catch (err) {
            if (!handleAuth(err)) showFileError(err.message || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
        } finally {
            busy(fileBtn, false);
        }
    });

    loadVersions();
})();
