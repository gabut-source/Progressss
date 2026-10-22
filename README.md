# WebGIS Progress Survey Zona

Aplikasi statis untuk GitHub Pages. Admin dapat mengunggah polygon zona dan SHP titik sampel. Data ditampilkan pada peta, ringkasan progress, serta rekap tanggal-surveyor.

## Publikasi data bersama

GitHub Pages tidak menyediakan server untuk menyimpan unggahan. Data hasil unggah awalnya tersimpan pada browser admin. Agar semua pengguna melihat dataset yang sama:

1. Pilih kabupaten, unggah polygon zona, lalu unggah SHP sampel harian.
2. Klik **Unduh data publikasi**. Aplikasi mengunduh `data.js` berisi polygon dan riwayat data semua kabupaten.
3. Ganti `data.js` pada root repository GitHub dengan file hasil unduhan, lalu commit dan push ke branch `main`.
4. Setelah GitHub Pages selesai deploy, semua pengguna melihat data bersama tersebut.

**Penting:** Repository dan situs GitHub Pages yang publik dapat diakses siapa pun. `data.js` publikasi berisi atribut sampel dan geometri yang diunggah. Jangan publikasikan data lapangan yang bersifat rahasia.

Login Admin statis di frontend hanya menyembunyikan form dari pengunjung biasa. Username dan password dapat ditemukan di kode situs; jangan menganggapnya sebagai perlindungan akses.

## Deploy ke GitHub Pages

1. Unggah file aplikasi ke root branch `main`.
2. Buka **Settings → Pages**, pilih **Deploy from a branch**, branch `main`, folder `/(root)`, lalu simpan.
3. Buka alamat Pages yang ditampilkan GitHub. Aplikasi dan peta dasar memerlukan koneksi internet karena pustaka dan tile peta dimuat dari CDN.

## Pemakaian

- Pilih kabupaten.
- Untuk mengunggah data, buka **Admin** dan masuk dengan username `tenn` serta password `welcome`.
- Di panel Admin, unggah polygon zona dan SHP titik sampel untuk kabupaten yang sedang dipilih.
- Target sampel per zona tetap 3. Rekap menampilkan semua tanggal; filter tanggal dan input target tidak tersedia.
- Muat polygon sekali dalam format ZIP shapefile atau GeoJSON. Properti kode zona sebaiknya `NOZN`. ZIP shapefile perlu berisi `.shp`, `.shx`, `.dbf`, dan `.prj` dengan nama dasar yang sama.
- Setiap hari, pilih **Tambah SHP sampel** dan unggah ZIP shapefile titik. Atribut perlu memuat nomor sampel, nama surveyor, dan tanggal pelaksanaan. Nomor zona opsional; tanpa kode zona, titik dipasangkan secara spasial ke polygon.
- Unggahan titik ditambahkan ke riwayat; kombinasi tanggal, ID sampel, dan zona yang sama tidak diduplikasi.
- Jika tersedia Excel, **Tambah Excel** dapat digunakan sebagai jalur cadangan.

## Perhitungan

- Titik unik dihitung dari `Nomor Identifikasi`, atau `Nomor Sampel` sebagai cadangan.
- Total zona dihitung dari feature polygon kabupaten terpilih.
- Zona tercapai dicatat satu kali pada tanggal pertama jumlah sampel kumulatifnya mencapai target (default 3). Sisa zona = total zona dikurangi zona tercapai.
- Jika satu titik berada pada lebih dari satu polygon, titik dapat dihitung untuk tiap zona yang beririsan.
- Jika beberapa surveyor bersama-sama mencapai target zona pada tanggal yang sama, zona masuk baris `Kolaborasi` agar total tidak terhitung ganda.

## Struktur file

- `index.html` — halaman utama
- `app.js` — peta, impor data, publikasi data, dan perhitungan progress
- `style.css` — tampilan
- `data.js` — dataset bersama, kosong pada awal instalasi
- `.nojekyll` — menjaga file statis disajikan langsung GitHub Pages
