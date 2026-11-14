# Kurgu Masası

Bir videoda **neyin ne zaman söyleneceğini** ve **ekranda ne olacağını** kararlaştırdığımız masa. Video kurgu programı değil.

- **Konuşma**: zaman çizelgesinde bir ana tıkla ve yaz. Uzunluğu metinden hesaplanır (Buse'nin hızı: 6,3 hece/sn) ve çizelgede aşağıdan yukarı vuran bir ışık bandı olarak görünür.
  - `/4` = 4 birim sessizlik (`/` tek başına 1 birim; birimin süresi üstteki "/1 =" ayarında). `/` yazınca editör yönlendirir.
  - `[köşeli parantez]` = yapay zekâya not, okunmaz.
  - Konuşmalar çakışırsa kırmızı gösterilir; tek tıkla "sonrasını kaydır".
- **Olay**: bir anda ne olduğu ("İşte burada ekran ikiye bölünür"); görsel referans, video, ses, dosya, bağlantı eklenir.
- **Ekran** (üstte): fare çizelgenin neresindeyse o anda söylenen sözcük, ekrandaki olay ve yaklaşan olaylar. `Boşluk` ile okuma hızında oynatılır.
- **Öneriler**: Claude MCP üzerinden önerir; uygularsan uygulanır, reddedersen hiçbir şey değişmez. Bekleyen önerilerin çizelgedeki yeri kesik çizgiyle görünür.
- **Terminal** (`⌨ Claude`, `Ctrl+\``): Claude Code proje klasöründe açılır; imlecin nerede olduğunu, o anda ne söylendiğini görür ("burada ne eksik?").
- **Geri al / yinele**: `Ctrl+Z` / `Ctrl+Shift+Z` (önerinin uygulanması da geri alınır).
- **HTML dışa aktarma**: hangi saniyede ne söyleniyor, ekranda ne oluyor, hazırlanacak görseller.

```bash
cd ~/Workspace/kurgu-masasi && npm start
```

Proje = bir klasör: `kurgu.json` + `medya/` (+ `disa-aktarim/`). Kısayollar uygulamada, proje panelinde.

Geliştirme: `npm test`; ekran görüntüsü: `npm run smoke -- <proje> <çıktı.png> [öğe id] [px/sn] [zaman]` (`KURGU_SMOKE_JS=<dosya>` ile pencerede bir test betiği çalıştırır). Ayrıntı: `CLAUDE.md`.
