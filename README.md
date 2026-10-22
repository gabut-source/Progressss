# WebGIS Progress Survey Zona

Aplikasi statis untuk GitHub Pages. Data titik contoh tidak disertakan di paket ini. Pilih kabupaten, unggah SHP polygon zona, lalu tambahkan SHP titik sampel secara berkala.

## Deploy ke GitHub Pages

1. Buat repository GitHub baru. Jangan unggah arsip SHP, GeoJSON, Excel lapangan, atau data.js yang berisi data lapangan.
2. Unggah semua file dari folder ini ke root branch `main`.
3. Di repository, buka **Settings → Pages**, pilih **Deploy from a branch**, branch `main`, folder `/ (root)`, lalu simpan.
4. Buka alamat Pages yang ditampilkan GitHub. Aplikasi dan peta dasar memerlukan internet karena pustaka dan tile peta dimuat dari CDN.

## Pemakaian

- Pilih kabupaten.
- Muat polygon zona sekali dalam format ZIP shapefile atau GeoJSON. Properti kode zona sebaiknya `NOZN`. Jika ZIP SHP, sertakan `.shp`, `.shx`, `.dbf`, dan `.prj` dengan nama dasar yang sama.
- Setiap hari, pilih **Tambah SHP sampel** dan unggah ZIP shapefile titik. Atribut perlu memuat nomor sampel, nama surveyor, serta tanggal pelaksanaan. Nomor zona bersifat opsional; tanpa kode zona, posisi titik akan dipasangkan ke polygon.
- Unggahan titik ditambahkan ke data yang sudah ada; pasangan tanggal, ID sampel, dan zona yang sama tidak diduplikasi. Polygon tersimpan sampai diganti.
- Jika tersedia Excel, tombol **Tambah Excel** dapat digunakan sebagai jalur cadangan.

## Penyimpanan dan privasi

Ini versi GitHub Pages tanpa server. Sampel dan polygon yang diunggah disimpan di IndexedDB browser yang sedang digunakan; data tidak tersimpan di GitHub dan tidak otomatis tersinkron antar perangkat/browser. Gunakan browser dan perangkat yang sama untuk pembaruan rutin. Simpan ZIP sumber harian sebagai arsip. Jangan taruh data sampel asli di repository publik.

Tile peta dasar diminta dari OpenStreetMap. Data tabel dan geometri sampel diproses di browser.

## Perhitungan

- Titik unik dihitung dari `Nomor Identifikasi`, atau `Nomor Sampel` sebagai cadangan.
- Satu zona dicatat pada tanggal pertama jumlah sampel kumulatifnya mencapai target (default 3).
- Jika satu titik berada pada lebih dari satu polygon, titik dapat dihitung untuk tiap zona yang beririsan.
- Jika beberapa surveyor bersama-sama mencapai target zona pada tanggal yang sama, zona masuk baris `Kolaborasi` agar total tidak terhitung ganda.

## Struktur file

- `index.html` — halaman utama
- `app.js` — peta, impor data, dan perhitungan progress
- `style.css` — tampilan
- `data.js` — inisialisasi kosong; jangan isi data privat untuk repository publik
- `.nojekyll` — menjaga file statis disajikan langsung GitHub Pages
