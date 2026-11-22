# ccdesk

Bir videoda **neyin ne zaman söyleneceğini** ve **ekranda ne olacağını** kararlaştırdığımız masa. Video kurgu programı değil.

- **Konuşma**: zaman çizelgesinde bir ana tıkla ve yaz. Uzunluğu metinden hesaplanır (Buse'nin hızı: 6,3 hece/sn) ve çizelgede aşağıdan yukarı vuran bir ışık bandı olarak görünür.
  - `/4` = 4 birim sessizlik (`/` tek başına 1 birim; birimin süresi üstteki "/1 =" ayarında). `/` yazınca editör yönlendirir.
  - `[köşeli parantez]` = yapay zekâya not, okunmaz.
  - Konuşmalar çakışırsa kırmızı gösterilir; tek tıkla "sonrasını kaydır".
- **Olay**: bir anda ne olduğu ("İşte burada ekran ikiye bölünür"); görsel referans, video, ses, dosya, bağlantı eklenir.
- **Ekran** (üstte): fare çizelgenin neresindeyse o anda söylenen sözcük, ekrandaki olay ve yaklaşan olaylar. `Boşluk` ile okuma hızında oynatılır.
- **Öneriler**: Claude MCP üzerinden önerir; uygularsan uygulanır, reddedersen hiçbir şey değişmez. Bekleyen önerilerin çizelgedeki yeri kesik çizgiyle görünür.
- **Terminal** (`⌨ Terminal`, `Ctrl+\``): proje klasöründe düz bir kabuk açılır; hangi yapay zekâyı (ya da hiçbirini) çalıştıracağınız size kalmış. MCP destekleyen bir asistanı projeye bağlamak için hazır yapılandırma `$CCDESK_MCP_CONFIG` değişkeninde (ör. `claude --mcp-config "$CCDESK_MCP_CONFIG"`), kullanım notu `$CCDESK_AGENT_PROMPT`'ta; bağlanan asistan imlecin nerede olduğunu, o anda ne söylendiğini görür.
- **Ayarlar** (`⚙`, `Ctrl+,`): solda menü, sağda ayarlar.
  - *Görünüm*: açık / koyu tema; arayüz yazı tipi (Roboto, Inter, sistem) ve konuşma metni yazı tipi (Courier Prime daktilo, IBM Plex Mono, Source Serif).
  - *Dil*: arayüz dili (yakında).
  - *Sesli okuma*: sağlayıcı seçimi ve sağlayıcıya özel ayarlar. **OmniVoice** (yerel, ses klonlama) yalnızca bilgisayar en az 4 GB'lık bir NVIDIA GPU ve 8 GB RAM taşıyorsa ve OmniVoice Python ortamı kuruluysa seçilebilir. **Azure Speech** (internet, ücretsiz F0 katmanı: ayda 500 bin karakter) bir Azure Speech anahtarı ve bölgesi ister; anahtar şifreli saklanır. "Okuma hızına eşitle" sesi projedeki konuşma hızına uydurur.
  - *Proje ayarları*: içerik dili (Türkçe / İngilizce): okuma süresi hesabı, sayıların okunuşu ve okuyan ses buna göre.
- **Geri al / yinele**: `Ctrl+Z` / `Ctrl+Shift+Z` (önerinin uygulanması da geri alınır).
- **HTML dışa aktarma**: hangi saniyede ne söyleniyor, ekranda ne oluyor, hazırlanacak görseller.

```bash
cd ~/Workspace/kurgu-masasi && npm start
```

Proje = bir klasör: `ccdesk.json` + `medya/` (+ `disa-aktarim/`). Kısayollar uygulamada, proje panelinde. Eski adla (`kurgu.json`) kaydedilmiş projeler ilk açılışta yeni ada geçer; uygulama ayarları `~/.config/ccdesk` (eskisi `~/.config/kurgu-masasi` bir kez taşınır).

Geliştirme: `npm test`; ekran görüntüsü: `npm run smoke -- <proje> <çıktı.png> [öğe id] [px/sn] [zaman]` (`CCDESK_SMOKE_JS=<dosya>` ile pencerede bir test betiği çalıştırır). Ayrıntı: `CLAUDE.md`.
