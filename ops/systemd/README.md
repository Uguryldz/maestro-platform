# Maestro systemd servisleri (hiç kapanmayan worker)

Maestro'yu **user-level** systemd servisi olarak koşturur: süreç ölürse 5 sn
içinde yeniden başlar, makine yeniden başlarsa (linger sayesinde) kimse oturum
açmadan kendiliğinden kalkar.

| Birim | Ne çalıştırır | Port |
| --- | --- | --- |
| `maestro-stack.service` | BFF + Studio (`demo-stack/src/bin/real-users.ts`, gerçek Postgres) | 7000, 7001 |
| `maestro-pilot.service` | Pilot motoru (`deploy/src/bin/pilot.ts`, DB-first) | 7020 |

## Kurulum

```bash
cd ~/coder/maestro/ops/systemd
./kur.sh          # kopyalar + daemon-reload + enable + linger — BAŞLATMAZ
```

`kur.sh` bilerek **start etmez**: elle/script ile açılmış Maestro süreçleri
varsa portlar çakışır. Uygun bir anda önce eskisini durdurun, sonra başlatın:

```bash
cd ~/coder/maestro
./maestro-baslat.sh stop
systemctl --user start maestro-stack maestro-pilot
```

> Not: Birimlerdeki `PATH` satırı nvm'in node sürümünü işaret eder
> (`v24.15.0`). `nvm` ile sürüm değiştirirseniz iki `.service` dosyasındaki
> satırı güncelleyip `kur.sh`'ı yeniden çalıştırın.

## Başlat / durdur / durum

```bash
systemctl --user start   maestro-stack maestro-pilot
systemctl --user stop    maestro-stack maestro-pilot
systemctl --user restart maestro-pilot
systemctl --user status  maestro-stack maestro-pilot
```

⚠ Canlı kullanım varken `restart` oturumları/kapıda bekleyen akışı düşürür —
pilot bir sonraki boot'ta kapıda kalan işi **yetim iş** uyarısıyla görünür
kılar (günlük + ticket yorumu), ama yine de restart'ı boş bir ana denk getirin.

## Log izleme

```bash
journalctl --user -u maestro-pilot -f     # pilot canlı log
journalctl --user -u maestro-stack -f     # BFF + Studio canlı log
journalctl --user -u maestro-pilot --since "1 hour ago"
```

Servisler `StandardOutput=journal` ile doğrudan journald'a yazar —
`/tmp/maestro-logs/*.log` dosyaları yalnız script yolunda oluşur.

## maestro-baslat.sh ile ilişki

`maestro-baslat.sh` ile systemd servisleri **aynı süreçleri** başlatır — ikisi
birden kullanılmaz (port çakışır). systemd kuruluysa script yerine servisleri
kullanın: script'in başlattığı süreç terminal/oturumla ilişkilidir ve ölünce
kimse yeniden başlatmaz; servis ise `Restart=always` ile kendini toparlar ve
boot'ta kendiliğinden kalkar. Script, systemd kurulu makinede yalnız
`./maestro-baslat.sh stop` (eski süreçleri temizlemek) için anlamlıdır.

## Bilinen tuzak: Studio ayakta görünüp port ölü (ENOSPC)

Belirti: `systemctl --user is-active maestro-stack` → `active`, ama 7000
yanıt vermiyor. Log'da:

```
Error: ENOSPC: System limit for number of file watchers reached
```

Sebep: Studio, Vite geliştirme sunucusuyla servis ediliyor ve monorepo'daki
kaynak dosyaları izliyor. Çekirdek limiti yetmediğinde Vite süreci ölür;
systemd birimi `Type=simple` olduğu için stack (BFF) ayakta kalır ve birim
`active` görünmeye devam eder — bu yüzden `is-active` tek başına yeterli
sağlık göstergesi değildir, portu da yoklayın.

Asıl darboğaz genelde `max_user_watches` değil `max_user_instances`'tır
(aynı makinede birden fazla izleyici süreç varsa hızla tükenir).

Kalıcı düzeltme (kurulu): `/etc/sysctl.d/99-maestro-inotify.conf`

```
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 524288
```

Uygulamak için `sudo sysctl --system`, sonra
`systemctl --user restart maestro-stack`.
