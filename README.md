# Progress

Aplikasi Progress di-host di GitHub Pages dengan data bersama di Supabase. Admin mengunggah ZIP shapefile zona dan sampel; pengguna lain membaca dataset terbaru dari database tanpa push data harian ke GitHub.

## Setup Supabase satu kali

1. Buat project Supabase.
2. Buka **SQL Editor**, jalankan isi `supabase/setup.sql`.
3. Jalankan juga `supabase/storage-migration.sql` untuk membuat bucket polygon dan aturan akses upload.
4. Di **Authentication → Users**, buat user admin dengan email dan password.
5. Salin UUID user tersebut, lalu jalankan SQL berikut dengan UUID yang benar:

   ```sql
   insert into public.webgis_admins (user_id)
   values ('UUID-USER-ADMIN');
   ```

6. Buka `supabase-config.js`. Isi `url` dan `publishableKey` dari **Project Settings → API Keys**. Publishable/anon key boleh digunakan di browser jika kebijakan RLS tetap aktif. Jangan pernah masukkan `service_role` atau secret key ke file frontend.
7. Commit dan push file aplikasi serta `supabase-config.js` ke GitHub. GitHub Pages akan tetap menjadi hosting situs.

## Penggunaan

- Buka **Admin**, login dengan email dan password Supabase yang dibuat pada langkah setup.
- Pilih kabupaten pada dropdown utama.
- Klik **Unggah ZIP SHP zona**, lalu pilih **Zona keseluruhan** untuk mengganti polygon kabupaten memakai ZIP shapefile biasa atau GeoJSON. ZIP harus berisi `.shp`, `.shx`, `.dbf`, dan `.prj` dengan nama dasar yang sama. Properti kode zona sebaiknya `NOZN`.
- Pilih **Zona per surveyor** untuk ZIP yang berisi beberapa SHP polygon. Nama setiap SHP menjadi nama surveyor setelah awalan `ZONA` dihapus, misalnya `ZONA Husein.shp` menjadi surveyor **Husein**. Semua SHP harus memiliki kolom `NOZN`. Saat pertama kali memakai mode ini, sertakan semua SHP surveyor agar gabungan zona kabupaten lengkap. Unggahan berikutnya boleh berisi surveyor yang ingin diperbarui saja; semua zona lama milik surveyor tersebut diganti. Total zona dihitung dari gabungan `NOZN` unik, dan filter surveyor menampilkan zona tanggung jawabnya.
- Unggah SHP sampel harian melalui **Tambah SHP sampel**. Atribut perlu memuat nomor sampel, nama surveyor, dan tanggal. Zona opsional; jika tidak tersedia, titik dicocokkan dengan polygon secara spasial.
- Setelah unggahan berhasil, titik dan atribut disimpan ke Supabase. Semua pengguna melihat data terbaru saat membuka atau memuat ulang situs.
- Target zona tetap 3 sampel. Rekap tabel menampilkan semua tanggal.
- Halaman dibuka pada tampilan ALL menggunakan polygon ringkas dan tanpa popup per polygon; titik sampel baru digambar setelah peta diperbesar. Untuk data zona yang telah tersimpan sebelum fitur ini, admin perlu memilih setiap kabupaten lalu menekan **Siapkan polygon ringkas ALL** satu kali. Jalankan ulang `supabase/storage-migration.sql` di SQL Editor agar bucket mengizinkan file gzip. Tampilan kabupaten individual tetap menggunakan polygon penuh dan popup detail.

## Data lama di browser

Data dari versi sebelum Supabase mungkin masih tersimpan hanya pada IndexedDB browser lama. Setelah setup Supabase dan login admin dari browser tersebut, gunakan tombol **Impor data lama dari browser** sekali untuk menyalinnya ke database bersama. Pastikan data lama itu memang ingin dipertahankan sebelum mengimpor.

## Akses dan privasi

Pengunjung dapat membaca polygon dan titik sampel agar peta publik berfungsi. Hanya user yang terdaftar di `webgis_admins` dapat menambah atau mengubah data. Karena situs ini publik, atribut dan koordinat sampel yang dapat dilihat di situs juga dapat diakses oleh pengunjung. Jangan unggah data rahasia tanpa mengubah kebijakan baca dan akses situs.

## Struktur

- `index.html`, `app.js`, `style.css` — aplikasi Progress.
- `supabase-config.js` — URL dan publishable key Supabase untuk frontend.
- `supabase/setup.sql`, `supabase/storage-migration.sql` — tabel, indeks, kebijakan akses, dan bucket polygon.
- `data.js` — data fallback kosong; dataset aktif dibaca dari Supabase jika konfigurasi tersedia.
