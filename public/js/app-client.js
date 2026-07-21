/* ============================================================
   WEPOSE app-client.js — logic khusus index.html:
   - baca form -> state object (format sama persis dgn yg dipakai report.js)
   - render preview pakai WeposeReport (engine yang sama dgn PDF)
   - riwayat (list/load/delete) dari Google Sheets via /api/assessments
   - simpan (create/update)
   - cetak PDF -> server (Puppeteer) -> download file
   ============================================================ */

let photoDataUrl = null;
let currentId = null;      // id record yang sedang diedit (null = record baru)
let isDirty = false;

/* ---------------- ukuran preview (zoom) ---------------- */
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;
const PAGE_WIDTH_MM = 210;
let previewZoom = parseFloat(localStorage.getItem('wepose_preview_zoom')) || 1;

function applyZoom() {
  previewZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, previewZoom));
  const wrap = document.getElementById('pagesZoomWrap');
  if (wrap) wrap.style.setProperty('--preview-zoom', previewZoom);
  const label = document.getElementById('zoomValue');
  if (label) label.textContent = Math.round(previewZoom * 100) + '%';
  localStorage.setItem('wepose_preview_zoom', previewZoom);
}
function zoomIn() { previewZoom += ZOOM_STEP; applyZoom(); }
function zoomOut() { previewZoom -= ZOOM_STEP; applyZoom(); }
function zoomReset() { previewZoom = 1; applyZoom(); }
function zoomFit() {
  const panel = document.querySelector('.preview-panel');
  if (!panel) return;
  const pageWidthPx = (PAGE_WIDTH_MM / 25.4) * 96; // konversi mm -> px pada 96dpi
  const available = panel.clientWidth - 24; // sisakan sedikit ruang di kanan-kiri
  previewZoom = available / pageWidthPx;
  applyZoom();
}
window.addEventListener('resize', () => { /* biarkan user set ulang manual via tombol "Sesuaikan" */ });

const DIM_KEYS = ['temuan', 'kekuatan', 'kelemahan', 'dimata', 'catatan'];

function val(id) { return document.getElementById(id) ? document.getElementById(id).value : ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v !== undefined && v !== null ? v : ''; }

/* ---------------- Stepper Component Helper ---------------- */
const SCORE_OPTIONS = [
  { label: "+5", category: "STRONG", value: 5 },
  { label: "+3", category: "MEDIUM", value: 3 },
  { label: "0", category: "NEUTRAL", value: 0 },
  { label: "-3", category: "WEAK", value: -3 },
  { label: "RF", category: "RED FLAG", value: "RF" }
];

function findScoreOptionIndex(val) {
  if (val === 'RF' || val === 'rf') return 4;
  const numVal = typeof val === 'number' ? val : parseInt(val, 10);
  const idx = SCORE_OPTIONS.findIndex(opt => opt.value === numVal);
  return idx !== -1 ? idx : 2; // Default to '0' (idx 2)
}

function getStepperValue(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const raw = (el.value || '').toString().trim();
  if (raw === 'RF' || raw === 'rf') return 'RF';
  const num = parseInt(raw, 10);
  return isNaN(num) ? 0 : num;
}

function setStepperValue(id, val) {
  const hiddenInput = document.getElementById(id);
  const displayEl = document.getElementById(id + '_display');
  const minusBtn = document.getElementById(id + '_minus');
  const plusBtn = document.getElementById(id + '_plus');

  const idx = findScoreOptionIndex(val);
  const selectedOpt = SCORE_OPTIONS[idx];

  if (hiddenInput) {
    hiddenInput.value = selectedOpt.value;
  }
  if (displayEl) {
    displayEl.innerHTML = selectedOpt.value === 'RF'
      ? `<span class="stepper-val-txt">RF</span> <span class="stepper-cat-txt">(RED FLAG)</span>`
      : `<span class="stepper-val-txt">${selectedOpt.label}</span> <span class="stepper-cat-txt">(${selectedOpt.category})</span>`;
    if (selectedOpt.value === 'RF') {
      displayEl.classList.add('is-rf');
    } else {
      displayEl.classList.remove('is-rf');
    }
  }
  // At index 0 (+5): cannot increase (+ btn disabled)
  // At index 4 (RF): cannot decrease (- btn disabled)
  if (plusBtn) plusBtn.disabled = (idx === 0);
  if (minusBtn) minusBtn.disabled = (idx === SCORE_OPTIONS.length - 1);
}

function stepScore(id, dir) {
  const currentRaw = document.getElementById(id) ? document.getElementById(id).value : 0;
  const currentIdx = findScoreOptionIndex(currentRaw);
  // dir +1 means higher score (moving left toward idx 0)
  // dir -1 means lower score (moving right toward idx 4)
  const newIdx = Math.max(0, Math.min(SCORE_OPTIONS.length - 1, currentIdx - dir));
  setStepperValue(id, SCORE_OPTIONS[newIdx].value);
  calculateTotalSkor();
  render();
}

function calculateTotalSkor() {
  const pillars = ['q_pekerjaan', 'q_skala_usaha', 'q_jabatan', 'q_lama_bekerja', 'q_penghasilan', 'q_bukti_dokumen'];
  let total = 0;
  let hasRF = false;
  for (const id of pillars) {
    const val = getStepperValue(id);
    if (val === 'RF') {
      hasRF = true;
    } else {
      total += val;
    }
  }
  const totalEl = document.getElementById('q_total_skor');
  const displayStr = hasRF ? `${total} (RF)` : `${total}`;
  if (totalEl) {
    totalEl.value = displayStr;
  }
  return { total, hasRF, displayStr };
}

/* ---------------- state <-> form ---------------- */
function buildStateFromForm() {
  const pekerjaan = getStepperValue('q_pekerjaan');
  const skala_usaha = getStepperValue('q_skala_usaha');
  const jabatan = getStepperValue('q_jabatan');
  const lama_bekerja = getStepperValue('q_lama_bekerja');
  const penghasilan = getStepperValue('q_penghasilan');
  const bukti_dokumen = getStepperValue('q_bukti_dokumen');

  const pekerjaan_catatan = val('q_pekerjaan_catatan');
  const skala_usaha_catatan = val('q_skala_usaha_catatan');
  const jabatan_catatan = val('q_jabatan_catatan');
  const lama_bekerja_catatan = val('q_lama_bekerja_catatan');
  const penghasilan_catatan = val('q_penghasilan_catatan');
  const bukti_dokumen_catatan = val('q_bukti_dokumen_catatan');

  const { total, hasRF, displayStr } = calculateTotalSkor();

  return {
    cover: {
      nama: val('c_nama'), umur: val('c_umur'), paspor: val('c_paspor'),
      negara: val('c_negara'), visa: val('c_visa'), tujuan: val('c_tujuan'),
      sponsor: val('c_sponsor'), tanggal: val('c_tanggal'), fotoDataUrl: photoDataUrl
    },
    skor_kuantitatif: {
      pekerjaan, pekerjaan_catatan,
      skala_usaha, skala_usaha_catatan,
      jabatan, jabatan_catatan,
      lama_bekerja, lama_bekerja_catatan,
      penghasilan, penghasilan_catatan,
      bukti_dokumen, bukti_dokumen_catatan
    },
    penilaian_kualitatif: {
      kemampuan_cuti: val('ql_kemampuan_cuti'),
      konsistensi_dokumen: val('ql_konsistensi_dokumen'),
      catatan_lokasi: val('ql_catatan_lokasi'),
      tier_katalog: val('ql_tier_katalog')
    },
    kesimpulan: {
      value: val('k_kesimpulan'),
      risiko: val('k_kesimpulan'), // for sheets.js compatibility
      total_skor: displayStr,
      narasi_penilaian: val('k_narasi_penilaian'),
      rekomendasi: val('k_rekomendasi')
    }
  };
}

function loadStateToForm(state) {
  const c = state.cover || {};
  setVal('c_nama', c.nama); setVal('c_umur', c.umur); setVal('c_paspor', c.paspor);
  setVal('c_negara', c.negara); setVal('c_visa', c.visa); setVal('c_tujuan', c.tujuan);
  setVal('c_sponsor', c.sponsor); setVal('c_tanggal', c.tanggal);
  photoDataUrl = c.fotoDataUrl || null;

  const sq = state.skor_kuantitatif || {};
  setStepperValue('q_pekerjaan', sq.pekerjaan !== undefined ? sq.pekerjaan : 0);
  setVal('q_pekerjaan_catatan', sq.pekerjaan_catatan || '');

  setStepperValue('q_skala_usaha', sq.skala_usaha !== undefined ? sq.skala_usaha : 0);
  setVal('q_skala_usaha_catatan', sq.skala_usaha_catatan || '');

  setStepperValue('q_jabatan', sq.jabatan !== undefined ? sq.jabatan : 0);
  setVal('q_jabatan_catatan', sq.jabatan_catatan || '');

  setStepperValue('q_lama_bekerja', sq.lama_bekerja !== undefined ? sq.lama_bekerja : 0);
  setVal('q_lama_bekerja_catatan', sq.lama_bekerja_catatan || '');

  setStepperValue('q_penghasilan', sq.penghasilan !== undefined ? sq.penghasilan : 0);
  setVal('q_penghasilan_catatan', sq.penghasilan_catatan || '');

  setStepperValue('q_bukti_dokumen', sq.bukti_dokumen !== undefined ? sq.bukti_dokumen : 0);
  setVal('q_bukti_dokumen_catatan', sq.bukti_dokumen_catatan || '');

  const pk = state.penilaian_kualitatif || {};
  document.getElementById('ql_kemampuan_cuti').value = pk.kemampuan_cuti || '-';
  setVal('ql_konsistensi_dokumen', pk.konsistensi_dokumen);
  setVal('ql_catatan_lokasi', pk.catatan_lokasi);
  document.getElementById('ql_tier_katalog').value = pk.tier_katalog || '-';

  const k = state.kesimpulan || {};
  document.getElementById('k_kesimpulan').value = k.value || k.risiko || 'WEAK';
  setVal('k_narasi_penilaian', k.narasi_penilaian);
  setVal('k_rekomendasi', k.rekomendasi);

  calculateTotalSkor();
}

/* ---------------- live preview ---------------- */
function render() {
  const state = buildStateFromForm();
  document.getElementById('pages').innerHTML = WeposeReport.renderAllPagesHTML(state);
  
  // Update photo preview in form panel
  const wrap = document.getElementById('photoPreviewWrap');
  if (wrap) {
    wrap.innerHTML = photoDataUrl
      ? `<img src="${photoDataUrl}">`
      : `<svg class="icon" viewBox="0 0 24 24" style="width:55%;height:55%;color:#fff;stroke-width:2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.5-7 8-7s8 3 8 7"/></svg>`;
  }

  markDirty();
  const runFit = () => requestAnimationFrame(() => requestAnimationFrame(() => WeposeReport.autofitAll(document)));
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(runFit).catch(runFit);
  } else {
    runFit();
  }
}

function handlePhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (ev) {
    photoDataUrl = ev.target.result;
    render();
  };
  reader.readAsDataURL(file);
}

/* ---------------- status / toast ---------------- */
function markDirty() {
  isDirty = true;
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (!dot || !text) return;
  dot.className = 'status-dot dirty';
  text.textContent = currentId ? 'Ada perubahan belum disimpan' : 'Belum disimpan';
}
function markSaved(id) {
  isDirty = false;
  currentId = id;
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = 'status-dot saved';
  text.textContent = 'Tersimpan ke Google Sheets';
}
let toastTimer = null;
function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

/* ---------------- riwayat (Google Sheets) ---------------- */
async function muatRiwayat() {
  const list = document.getElementById('historyList');
  list.innerHTML = '<div class="history-empty"><span class="spinner"></span>&nbsp; Memuat riwayat...</div>';
  try {
    const res = await fetch('/api/assessments');
    if (!res.ok) throw new Error('Gagal memuat riwayat (' + res.status + ')');
    const rows = await res.json();
    if (!rows.length) {
      list.innerHTML = '<div class="history-empty">Belum ada data tersimpan.</div>';
      return;
    }
    list.innerHTML = rows.map(r => {
      let badgeClass = 'hbadge-sedang';
      if (r.risiko === 'STRONG') badgeClass = 'hbadge-rendah';
      else if (r.risiko === 'RED FLAG' || r.risiko === 'WEAK') badgeClass = 'hbadge-tinggi';
      return `
        <div class="history-item">
          <div class="hname">${escapeHtml(r.nama || '(tanpa nama)')}</div>
          <div class="hmeta">${escapeHtml(r.paspor || '-')} · ${escapeHtml(r.negara || '-')} · ${escapeHtml(r.tanggal || '-')}</div>
          ${r.risiko ? `<span class="hbadge ${badgeClass}">${escapeHtml(r.risiko)}</span>` : ''}
          <div class="hactions">
            <button class="hbtn-load" onclick="muatRecord('${r.id}')">Muat</button>
            <button class="hbtn-del" onclick="hapusRecord('${r.id}')">Hapus</button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = '<div class="history-empty">Gagal memuat riwayat: ' + escapeHtml(err.message) + '</div>';
  }
}

async function muatRecord(id) {
  try {
    const res = await fetch('/api/assessments/' + encodeURIComponent(id));
    if (!res.ok) throw new Error('Data tidak ditemukan');
    const state = await res.json();
    loadStateToForm(state);
    currentId = id;
    render();
    markSaved(id);
    showToast('Data dimuat ke form.');
  } catch (err) {
    showToast('Gagal memuat data: ' + err.message, true);
  }
}

async function hapusRecord(id) {
  if (!confirm('Hapus data ini dari Google Sheets? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    const res = await fetch('/api/assessments/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) throw new Error('Gagal menghapus (' + res.status + ')');
    showToast('Data dihapus.');
    if (currentId === id) mulaiBaru();
    muatRiwayat();
  } catch (err) {
    showToast('Gagal menghapus: ' + err.message, true);
  }
}

async function simpanRiwayat() {
  const btn = document.getElementById('btnSave');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Menyimpan...';
  try {
    const state = buildStateFromForm();
    const payload = { id: currentId, state };
    const res = await fetch('/api/assessments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Gagal menyimpan (' + res.status + ')');
    const data = await res.json();
    markSaved(data.id);
    showToast('Tersimpan ke Google Sheets.');
    muatRiwayat();
  } catch (err) {
    showToast('Gagal menyimpan: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function mulaiBaru() {
  resetForm();
  currentId = null;
  markDirty();
  document.getElementById('statusText').textContent = 'Belum disimpan';
}

/* ---------------- cetak PDF (server-side, Puppeteer) ---------------- */
async function cetakPDF() {
  const btn = document.getElementById('btnPdf');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = '⏳ Menyiapkan PDF...';
  try {
    const state = buildStateFromForm();
    const pdfRes = await fetch('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!pdfRes.ok) {
      const errText = await pdfRes.text().catch(() => '');
      throw new Error('Gagal membuat PDF ' + (errText ? '— ' + errText : ''));
    }
    const blob = await pdfRes.blob();
    const url = URL.createObjectURL(blob);
    const namaFile = (val('c_nama') || 'profile-assessment').trim().replace(/\s+/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `WEPOSE_${namaFile}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('PDF siap diunduh.');
  } catch (err) {
    showToast(err.message || 'Gagal membuat PDF', true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

/* ---------------- util ---------------- */
function escapeHtml(s) {
  return (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------------- sample & reset ---------------- */
function fillSample() {
  setVal('c_nama', 'Budi Santoso');
  setVal('c_umur', '38 tahun');
  setVal('c_paspor', 'E7503067');
  setVal('c_negara', 'Prancis');
  setVal('c_visa', 'Schengen C - Wisata');
  setVal('c_tujuan', 'Wisata');
  setVal('c_sponsor', 'Biaya Sendiri');
  setVal('c_tanggal', new Date().toISOString().slice(0, 10));

  setStepperValue('q_pekerjaan', 3);
  setVal('q_pekerjaan_catatan', 'Berstatus karyawan kontrak (probation) di Toko Elektronik.');

  setStepperValue('q_skala_usaha', -3);
  setVal('q_skala_usaha_catatan', 'Usaha perorangan skala kecil (3-5 karyawan) tanpa jejak digital resmi.');

  setStepperValue('q_jabatan', 0);
  setVal('q_jabatan_catatan', 'Posisi Staf Administrasi & Kasir Toko.');

  setStepperValue('q_lama_bekerja', -3);
  setVal('q_lama_bekerja_catatan', 'Masa kerja sangat singkat (3 bulan).');

  setStepperValue('q_penghasilan', 3);
  setVal('q_penghasilan_catatan', 'Penghasilan IDR 3.200.000/bulan (gaji pokok + makan).');

  setStepperValue('q_bukti_dokumen', 'RF');
  setVal('q_bukti_dokumen_catatan', 'Tidak ada slip gaji resmi, BPJS, atau SPT. Gaji tunai/transfer pribadi.');

  document.getElementById('ql_kemampuan_cuti').value = 'WEAK';
  setVal('ql_konsistensi_dokumen', 'Dokumen pendukung sangat lemah dan tidak konsisten. Mutasi rekening tidak mencerminkan penerimaan gaji yang teratur. Ketiadaan dokumen formal seperti slip gaji resmi, BPJS, dan bukti potong pajak, serta kontrak kerja yang sederhana, menunjukkan kurangnya formalitas dan verifikasi yang kuat.');
  setVal('ql_catatan_lokasi', 'Perusahaan adalah usaha perorangan dengan skala sangat kecil (3-5 karyawan) tanpa jejak digital yang memadai, menunjukkan operasional yang informal dan terbatas.');
  document.getElementById('ql_tier_katalog').value = 'Tier 3';

  setVal('k_narasi_penilaian', 'Berdasarkan analisis profil pekerjaan dan penghasilan subjek, ditemukan bahwa subjek saat ini berstatus karyawan kontrak (masa percobaan/probation) dengan masa kerja yang sangat singkat, yaitu 3 bulan, di Toko Elektronik & Servis Makmur Jaya, sebuah usaha perorangan dengan jumlah karyawan antara 3-5 orang tanpa jejak digital perusahaan yang kuat. Subjek menempati posisi Staf Administrasi & Kasir Toko dengan penghasilan bulanan sebesar IDR 3.200.000, yang terdiri dari gaji pokok IDR 2.800.000 dan uang makan IDR 400.000 yang tidak tetap. Metode penerimaan gaji bersifat informal, yaitu tunai atau ditransfer dari rekening pribadi pemilik toko, bukan rekening perusahaan.\n\nSecara verifikasi, subjek tidak terdaftar BPJS Ketenagakerjaan, tidak rutin menerima slip gaji resmi, dan tidak memiliki bukti potong pajak tahunan. Kontrak kerja yang dimiliki adalah surat kesepakatan sederhana tanpa kop surat resmi perusahaan dan tanpa meterai.\n\nTerkait informasi cuti, subjek mengajukan cuti di luar tanggungan (unpaid leave) secara lisan, tanpa surat izin resmi dari toko, dan hanya mendapat persetujuan melalui chat WhatsApp. Tidak ada jaminan tertulis mengenai posisi subjek setelah kembali bekerja.\n\nDokumen pendukung yang dilampirkan juga sangat lemah: rekening tabungan pribadi 2 bulan terakhir menunjukkan mutasi masuk yang tidak konsisten, hanya terdapat foto kwitansi gajian tulisan tangan, serta tangkapan layar chat WhatsApp izin libur. Hal ini menunjukkan tingkat formalitas dan konsistensi data yang sangat rendah.');
  document.getElementById('k_kesimpulan').value = 'RED FLAG';
  setVal('k_rekomendasi', 'Meminta surat keterangan kerja resmi bermeterai dengan kop surat toko.\nMelampirkan mutasi rekening koran 3-6 bulan terakhir yang lebih konsisten.\nMelampirkan bukti kepemilikan aset keluarga atau bukti ikatan keluarga yang lebih kuat di Indonesia.');

  calculateTotalSkor();
  render();
}

function resetForm() {
  document.querySelectorAll('input[type=text],input[type=number],input[type=date],textarea').forEach(el => el.value = '');
  ['q_pekerjaan', 'q_skala_usaha', 'q_jabatan', 'q_lama_bekerja', 'q_penghasilan', 'q_bukti_dokumen'].forEach(id => {
    setStepperValue(id, 0);
  });
  ['q_pekerjaan_catatan', 'q_skala_usaha_catatan', 'q_jabatan_catatan', 'q_lama_bekerja_catatan', 'q_penghasilan_catatan', 'q_bukti_dokumen_catatan'].forEach(id => {
    setVal(id, '');
  });
  document.getElementById('ql_kemampuan_cuti').value = '-';
  document.getElementById('ql_tier_katalog').value = '-';
  document.getElementById('k_kesimpulan').value = 'RED FLAG';
  photoDataUrl = null;
  calculateTotalSkor();
  render();
}

/* ---------------- init ---------------- */
render();
muatRiwayat();
applyZoom();
