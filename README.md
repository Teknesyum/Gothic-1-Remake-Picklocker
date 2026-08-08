# Gothic 1 LockPicker

Gothic 1 (Remake) oyunundaki plaka/kilit açma mini oyununu çözen, oyunun üzerine yerleşen şeffaf bir Electron overlay aracı. Başlangıç konumlarını ve plaka etkileşim yönlerini girersiniz; program en kısa hamle dizisini bulur ve isterseniz WASD tuşlarıyla otomatik olarak uygular.

## Kurulum

Windows'ta PowerShell açıp tek satır çalıştırın:

```powershell
irm https://raw.githubusercontent.com/Teknesyum/Gothic-1-Remake-Picklocker/master/install.ps1 | iex
```

Bu komut [Git](https://git-scm.com/downloads) ve [Node.js](https://nodejs.org) kurulu olmasını gerektirir. Betik repoyu `%LOCALAPPDATA%\Gothic1LockPicker` içine indirir, bağımlılıkları kurar ve masaüstüne çift tıklayınca gizli çalışan bir başlatıcı (`Gothic 1 LockPicker.bat`) bırakır.

Program her açılışta otomatik güncelleme kontrolü yapar; yeni bir sürüm varsa güncellemek isteyip istemediğinizi sorar.

## Kullanım

1. `Gothic 1 LockPicker.bat` ile başlatın (veya oyun içindeyken **F9** ile paneli açıp kapatın).
2. **1. Başlangıç Konumları** bölümünde her plakanın mevcut konumunu işaretleyin.
3. **2. Etkileşim Yönleri** bölümünde hangi hareketin hangi plakaları nasıl etkilediğini (aynı yönde/ters yönde) girin.
4. **ÇÖZ** ile kısa bir çözüm özeti görün, ya da doğrudan **OTOMATİK ÇÖZ** ile bulunan çözümü oyuna uygulayın.

### Kısayollar

| Tuş | İşlev |
| --- | --- |
| `F9` / `F10` / `Ctrl+Space` / `Alt+Z` | Paneli aç/kapat |
| `Alt+X` / `F8` | Çalışan makroyu acil durdur |

### Auto Mod ve Pasif Mod

- **Auto Mod**: Kilit ekranından bir köşe şablonu belirlediğinizde, program o şablonu ekranda algıladığında paneli otomatik gösterir/köşedeki butonu görünür kılar; algılama kaybolunca panel otomatik küçülür.
- **Pasif Mod**: Panel kapalıyken köşedeki buton tamamen gizlenir, yalnızca fare tam o köşeye geldiğinde tekrar görünür. Paneli açmanın tek yolları F9 veya köşeye gelip tıklamaktır.

## Geliştirme

```bash
npm install
npm run electron:dev   # Vite dev sunucusu + Electron birlikte
npm run test           # LockSolver birim testleri (vitest)
npm run lint           # oxlint
npm run dist           # Taşınabilir .exe üretir (release/)
```

Mimari detayları ve tasarım kararları için [`CLAUDE.md`](CLAUDE.md) dosyasına bakın.
