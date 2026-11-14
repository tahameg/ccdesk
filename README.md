# Kurgu Masası

Bir videonun kurgusunu birlikte tartışmak için zaman çizelgesi. Kurgu yapmaz; neyin ne zaman söyleneceğini ve ekranda ne olacağını kararlaştırır.

- **Senaryo**: bir aralığa gömülen, yalnızca söylenecek metin. `[köşeli parantez]` içi okunmaz, yapay zekâya nottur. Her senaryonun okuma süresi tahmin edilir (Buse'nin ölçülen hızı: 6,3 hece/sn) ve aralığa sığmıyorsa uyarır.
- **Not**: bir aralığa ya da tek bir ana (olay) bağlı kurgu fikri: "burada sağda panel", "tam bu anda ekran ikiye bölünür". Nota her türlü medya (görsel, video, ses, dosya, bağlantı) eklenir; dosyalar proje klasörüne kopyalanır.
- **Yorum**: bir senaryoya, nota, bir ana ya da projeye. Çözülmemiş yorum sayısı hep üstte görünür.
- Senaryolar ve notlar üst üste binebilir.
- **Claude** aynı projeye MCP üzerinden ayrı bir kullanıcı olarak katılır: okur, yorum yazar, senaryo ve notları değiştirir. Değişiklikleri uygulamada anında görünür.
- **HTML dışa aktarma**: hangi saniyede ne söyleniyor, ekranda ne olmalı, hazırlanacak görseller, açık yorumlar.

## Çalıştırma

```bash
cd ~/Workspace/kurgu-masasi && npm start
```

Proje = bir klasör: `kurgu.json` (her şey) + `medya/` (notlara eklenen dosyalar) + `disa-aktarim/` (HTML).

Kısayollar: `V` seç, `S` senaryo çiz, `N` not çiz, `E` olay koy, `Del` sil, `←/→` 0,1 sn kaydır (`Shift` ile 1 sn), `Ctrl + tekerlek` yakınlaştır, cetvele tıkla: imleç.

## Geliştirme

`npm test` (çekirdek + MCP), `npm run smoke -- <proje> <çıktı.png> [öğe id] [px/sn]` (pencereyi açmadan ekran görüntüsü). Ayrıntı: `CLAUDE.md`.
