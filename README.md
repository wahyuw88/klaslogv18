# Dashboard Klaster Logistik

Dashboard satu halaman untuk memantau ringkasan, peta sebaran, dan daftar Klaster Logistik Penanggulangan Bencana di Indonesia.

## Deployment

- Vercel sebagai static site.
- Framework Preset: Other.
- Root Directory: `.`.
- Build Command dan Install Command dikosongkan.
- Output Directory: `public`.
- Halaman utama: `public/index.html`.

## Struktur proyek

```text
public/
  index.html
  app.js
  history-validator.js
  styles.css
  data/
    master-wilayah.json
    template-histori-status.csv
tests/
  history-validator.test.js
README.md
```

## Antarmuka v18

- Navigasi hanya menyediakan Ringkasan dan Peta & Data.
- Halaman Analisis dan Kualitas Data dihapus dari antarmuka.
- Beranda hanya menampilkan empat indikator: entitas klaster teridentifikasi, klaster provinsi terbentuk, klaster kabupaten/kota terbentuk, dan dalam proses.
- Kartu Belum Terbentuk, Perlu Verifikasi, Identitas Terverifikasi, dan Data Sementara dihapus.
- Filter tahun dan status dihapus. Filter Korwil, jenis wilayah, pencarian, pengurutan, pagination, dan ekspor CSV tetap tersedia.
- Peta mengikuti pilihan Korwil dan jenis wilayah.
- Tabel tetap menampilkan kolom status, tahun, dan kualitas baris untuk konteks operasional.

## Sumber data

Sumber utama dibaca dari Google Sheets melalui `SHEET_CSV_URL` di `public/app.js`, mengarah ke sheet `DATA_KLASTER`. Pastikan URL publikasi dan `gid` benar sebelum mengubahnya.

Header kanonis yang diharapkan:

`cluster_id,nama_klaster,kode_provinsi,nama_provinsi,kode_kab_kota,nama_kab_kota,jenis_wilayah,status_pembentukan,tahun_pembentukan,nama_korwil`

Master wilayah statis ada di `public/data/master-wilayah.json`. Master bawaan merupakan referensi historis dan tidak boleh dianggap sebagai daftar administrasi terkini tanpa verifikasi ke sumber resmi. Data master tidak diubah dalam pembaruan antarmuka v18.

## Validasi histori status v17

`public/history-validator.js` menyediakan validasi histori atomik. Satu event bermasalah mengarantina seluruh rangkaian `cluster_id`. Validator menolak ID kosong/tidak dikenal/duplikat pada data utama, baseline tidak lengkap/tidak konsisten, tanggal tidak valid, urutan event ambigu, status yang tidak diizinkan, rangkaian terputus, dan konflik status akhir.

Skema histori:

`cluster_id,tanggal_perubahan,waktu_perubahan,urutan_event,status_sebelumnya,status_baru,diubah_oleh,catatan_perubahan,referensi_bukti,baseline_status,baseline_tanggal,baseline_sumber`

Baseline harus diulang pada setiap event untuk ID yang sama. Untuk beberapa event pada tanggal sama, gunakan waktu unik atau nomor urut positif unik. Bila keduanya diisi, urutannya harus konsisten. Status yang diizinkan: `Terbentuk` dan `Dalam Proses`.

`HISTORY_CSV_URL` tetap kosong sampai sheet `HISTORI_STATUS` tersedia dan dipublikasikan sebagai CSV. Template tersedia pada `public/data/template-histori-status.csv`. Validator dan pengujiannya tersedia, tetapi histori belum dihubungkan ke UI ringkasan v18.

## Pengujian otomatis

Jalankan dari root proyek:

```bash
node --check public/app.js
node --check public/history-validator.js
node --test tests/history-validator.test.js
```

Pengujian yang disertakan mencakup event valid, karantina seluruh rangkaian, ID duplikat, urutan parsial/bertentangan, baseline tidak konsisten, ID kosong/tidak dikenal, dan tanggal tidak valid.

## Batasan operasional

- Peta memakai Leaflet, GeoJSON, dan basemap eksternal; bila layanan eksternal gagal, tabel tetap tersedia.
- Tidak ada backend, autentikasi, atau audit trail permanen.
- `HISTORY_CSV_URL` belum dikonfigurasi.
- Pengujian otomatis bukan pengganti uji browser, mobile, integrasi Google Sheets aktif, dan pemeriksaan deployment Vercel.
