# LAX CRM — Sistema de Backups

Backups del Postgres de producción + env vars cifradas, guardados en un
bucket S3-compatible de Railway (`lax-crm-backups`, región `ams`).

## TL;DR

```bash
cd ~/Projects/lax-group-crm/backups

# Hacer backup antes de un cambio
./backup.sh "before-logo-fix"

# Listar backups disponibles
./restore.sh

# Restaurar uno concreto (pide doble confirmación)
./restore.sh 20260528-001234
```

## Qué se respalda

| Archivo | Contenido |
|---|---|
| `YYYYMMDD-HHMMSS_<label>.sql.gz` | Dump completo del Postgres (`pg_dump --clean --if-exists --format=plain`), gzipeado |
| `YYYYMMDD-HHMMSS_<label>.env.gpg` | Variables de entorno de los servicios `LAX Group CRM` + `Database`, cifradas con AES-256 |

Cubre: usuarios y contraseñas (hash bcrypt en tablas), leads, configuraciones
de Meta CAPI por cliente, etiquetas de pipeline personalizadas, sesiones,
API keys de Meta, todas las env vars de Railway.

**No cubre** (no hace falta): código fuente — eso está en GitHub con historial.

## Retención

Mantiene los **7 backups más recientes** en el bucket. Los más antiguos
se borran automáticamente al final de cada `backup.sh`.

Cambiar el límite editando `BACKUP_RETENTION` en
`~/.config/lax-crm-backups/env`.

## Archivos de configuración (locales, NO en git)

| Ruta | Contenido | Permisos |
|---|---|---|
| `~/.config/lax-crm-backups/env` | Credenciales S3 (access key/secret), IDs de Railway, retención | `600` |
| `~/.config/lax-crm-backups/gpg-passphrase` | Passphrase de cifrado de env vars | `600` |
| `~/.ssh/id_ed25519` | Llave SSH para `railway ssh` (subida a Railway con `railway ssh keys add`) | `600` |

⚠️ Si pierdes la passphrase GPG, **no podrás descifrar los `.env.gpg` antiguos**.
La passphrase también está apuntada en el password manager del owner.

## Cómo funciona (paso a paso)

1. **Dump del DB**: `railway ssh --service Database "pg_dump ..."` ejecuta
   `pg_dump` dentro del contenedor de Postgres y nos manda el resultado por
   stdout. Lo comprimimos con `gzip -9` en local. **El Postgres nunca se
   expone públicamente.**
2. **Env vars**: `railway variables --kv` lista las env vars de cada
   servicio, las concatenamos en un único `.env` temporal y lo ciframos con
   `gpg --symmetric --cipher-algo AES256` usando la passphrase.
3. **Upload**: `aws --endpoint-url=$S3_ENDPOINT s3 cp` sube ambos archivos
   al bucket de Railway.
4. **Rotación**: lista los `.sql.gz`, ordena por timestamp descendente,
   conserva los 7 primeros, borra los demás (junto con su `.env.gpg`
   correspondiente).

## Restaurar (rollback)

```bash
./restore.sh                       # lista los backups del bucket
./restore.sh 20260528-001234       # descarga + confirma 2 veces + restaura
```

El restore:
- Descarga el `.sql.gz` del bucket
- Pide escribir literalmente `RESTORE` y luego el prefijo del backup
- Hace `gunzip | railway ssh ... psql` → restaura sobre el DB de producción
- El dump usa `--clean --if-exists`, así que **destruye las tablas actuales
  antes de recargar** (no hace merge)

### Restaurar solo env vars

```bash
# Descargar y descifrar:
aws --endpoint-url=$S3_ENDPOINT s3 cp \
  s3://lax-crm-backups-su0-ygbha/20260528-001234_before-logo-fix.env.gpg ./envs.gpg

gpg --decrypt --batch --pinentry-mode loopback \
  --passphrase-file ~/.config/lax-crm-backups/gpg-passphrase \
  --output ./envs.txt ./envs.gpg

less ./envs.txt
```

Luego copiar y pegar las variables que necesites en el dashboard de Railway
o con `railway variables set KEY=VALUE`.

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `Host key verification failed` | `ssh.railway.com` no está en `known_hosts` | `ssh-keyscan -t ed25519 ssh.railway.com >> ~/.ssh/known_hosts` |
| `Missing command: gpg` | Brew no terminó / PATH | `eval "$(~/homebrew/bin/brew shellenv)"` o reabrir terminal |
| `aws: command not found` | Idem | Idem |
| `Unauthorized` (railway CLI) | Sesión expirada | `railway login` |
| Dump muy pequeño (<1KB) | DB vacío o error de pg_dump | El script aborta. Revisar `railway logs --service Database` |

## Inventario actual

```bash
# Ver backups en el bucket
source ~/.config/lax-crm-backups/env
aws --endpoint-url=$S3_ENDPOINT s3 ls s3://$S3_BUCKET/
```
