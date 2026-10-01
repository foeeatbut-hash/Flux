# Развёртывание базы Flux на PostgreSQL

У PostgreSQL нет «файла базы» как у SQLite — база создаётся на сервере, а таблицы разворачиваются скриптом `flux-postgres-init.sql`.

## На сервере

1. Установить PostgreSQL 15+ (Windows: установщик с postgresql.org, порт 5432, запомнить пароль `postgres`).

2. Создать пользователя и базу (SQL Shell / pgAdmin → Query Tool, под `postgres`):
   ```sql
   CREATE USER flux WITH PASSWORD 'СВОЙ_ПАРОЛЬ';
   CREATE DATABASE flux OWNER flux;
   ```

3. Развернуть таблицы — выполнить `flux-postgres-init.sql` в базе `flux`:
   ```
   psql -U flux -d flux -f flux-postgres-init.sql
   ```
   Либо pgAdmin: база `flux` → Query Tool → открыть файл → Execute.

4. Разрешить подключения по сети:
   - `postgresql.conf`: `listen_addresses = '*'`
   - `pg_hba.conf`, добавить строку под свою локальную сеть:
     ```
     host  all  all  192.168.0.0/16  scram-sha-256
     ```
   - Перезапустить службу PostgreSQL, открыть порт 5432 в брандмауэре.

## В программе Flux (на каждом рабочем месте)

Настройки → База данных → режим «Совместный / Внешний», строка подключения:
```
postgresql://flux:СВОЙ_ПАРОЛЬ@IP-СЕРВЕРА:5432/flux
```
Нажать «Переключить». Пустая база не получает пароль администратора по умолчанию: настройте владельца и создайте сотрудника с личным паролем.
