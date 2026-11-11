# 开发与测试用哪个数据库，线上库怎样隔离

2026-11-10 一次开发运行里，业务 Session 想用一次性集群跑测试，但端口 55432 已被本机线上 PostgreSQL 占用；它没先核对就继续，在线上服务上建了两个测试库并跑了迁移和测试（业务库没被连接，事后已删）。原因有两层：测试只检查**库名**是 `evoloop_*_test`，而这样的库在任何服务器上都能建；线上实例对同一系统用户的 Session 又不要求密码。本页把“开发和测试用哪个库”写死，并列出需要维护者执行的隔离步骤。仓库侧的保护已经在代码里；实例与认证属于维护者的私有配置，**本页的步骤没有在运行中的实例上执行过**。

## 开发与测试用哪个实例

- **只用独立的开发/测试 PostgreSQL 实例**：自己的端口、自己的数据目录，里面只放 `postgres`、模板库和 `evoloop_*` 库（例如 `evoloop_local_test`、`evoloop_dev`）。线上实例的业务库叫 `evoloop`，只给协调服务用。
- **怎样确认不是线上**：`TEST_DATABASE_URL` 的库名必须是 `evoloop_*_test`，并且那台服务器上不能有 `evoloop_*` 以外的库——
  ```sh
  psql "$TEST_DATABASE_URL" -d postgres -Atc "show data_directory; show port; select datname from pg_database order by 1"
  ```
  数据目录、端口应是你自己的开发实例；库列表里出现 `evoloop`（或任何非 `evoloop_*` 的库）就是线上或共享实例，不要在上面跑。
- **自己起一个一次性开发实例**（不碰线上；端口取一个空闲值，下面 `PORT` 换成它）：
  ```sh
  D=/tmp/evoloop-dev-pg; initdb -D $D/data -U evotest --auth=trust
  pg_ctl -D $D/data -o "-p $PORT -k $D -c listen_addresses=127.0.0.1" -l $D/pg.log -w start
  createdb -h 127.0.0.1 -p $PORT -U evotest evoloop_local_test
  TEST_DATABASE_URL=postgres://evotest@127.0.0.1:$PORT/evoloop_local_test npm run test:integration
  ```
  `-k $D` 把 Unix 套接字放进自己的目录，默认套接字不会连到别的实例；用完 `pg_ctl -D $D/data stop`。先核端口确实空闲：端口已被占用时 `pg_ctl` 会失败，不要因此改去连占用它的那台服务。

## 仓库里的保护

- `scripts/lib/database-target.mjs`：按“这台服务器托管了什么”判断，而不只看库名。库名必须是 `evoloop_*_test`；服务器上若还有 `postgres`、模板库、`evoloop_*` 以外的库（线上库就是 `evoloop`），视为线上或共享实例，拒绝运行并说明原因；连不上服务器、读不到库列表同样拒绝。
- 生效位置：`npm run test:integration`（会创建库，先检查）；`npm run test:db -- <测试文件>`（预加载保护）；所有读取 `TEST_DATABASE_URL` 的测试文件（约 95 个）第一行就引入同一保护，所以直接用 `node --import tsx --test <文件>` 也会被拦。拒绝时进程以 78 退出。
- 唯一的覆盖：`EVOLOOP_DEV_DATABASE_SERVER=host:port`，写明**那一台**服务器，只用于确实要共享的开发实例；写别的服务器地址不会放行这一台。
- 保护检验：`scripts/database-target.test.mjs`（在 `npm run test:unit` 里）用假的库列表证明会拒绝线上目标，不需要任何实例。

## 保护不覆盖什么

保护只在**仓库的测试和脚本**里生效。Session 手工运行 `psql`、自己写的脚本、或任何不经过这些入口的连接不受它约束；并且 Session 与 PostgreSQL 同属一个系统用户，能读到协调服务的私有配置。下面的维护者步骤能挡住“顺手连上”的误用，但**不能**挡住有意读取配置文件里的密码；真要隔离到那一步，需要给开发 Session 单独的系统用户或容器（方案 C）。

## 方案比较（由维护者选定）

| 方案 | 做什么 | 代价 | 挡住什么 |
| --- | --- | --- | --- |
| A（推荐）开发实例 + 线上实例要密码 | 开发/测试用上面的独立实例；线上实例的 `pg_hba.conf` 全部改为 `scram-sha-256`，协调服务带密码连接 | 多一个实例；协调服务配置改动并重启一次；密码放进私有配置 | 同一系统用户的 Session 用平常方式 `psql` 连线上会被要求密码而失败；仓库测试也不会误连 |
| B 只在原实例里加专用角色并限制 `pg_hba` | 给开发/测试单独的角色，限定可连的库 | 不用新实例，但线上服务器里仍有开发库，“库名”之外没有边界；测试保护会拒绝这种布局，除非显式覆盖 | 只挡误用，边界弱 |
| C 开发 Session 用独立系统用户或容器 | 开发 Session 读不到线上私有配置，也连不到线上套接字 | 运维成本最高 | 连有意读取也被挡住 |

## 维护者步骤（方案 A；标 [维护者] 的由有权限的维护者在空闲窗口执行，我没有执行任何一步）

1. **[维护者] 备份并确认可恢复。** 停协调服务，按[本机运行](local-run.md)的备份与恢复演练备份线上库，并在新空库里验证能恢复；记下改动前的业务计数（Task、Document、Operation 数量）与 `pg_hba.conf` 副本。
2. **[维护者] 起开发/测试实例。** 如上节：独立端口、独立数据目录、`-k` 指向自己的目录；开发者把 `TEST_DATABASE_URL` 指过去。
3. **[维护者] 给线上实例设密码认证。** 给协调服务用的角色设密码（`ALTER ROLE … PASSWORD …`，密码不进 shell 历史和 Git）；把线上实例 `pg_hba.conf` 中 `local`、`127.0.0.1/32`、`::1/128` 的方法都改成 `scram-sha-256`，`pg_ctl reload`（不用重启实例）。是否需要改成非超级用户角色，取决于迁移要不要超级用户权限，**本仓库迁移没有为此验证过**，先只做密码认证。
4. **[维护者] 改协调服务的连接串并重启。** 在私有环境里把 `EVOLOOP_DATABASE_URL` 换成带密码的地址；重启后 `/health` 应为 ok，业务计数与第 1 步一致。
5. **[维护者] 验证隔离。** 在一个业务 Session 的工作区里用平常方式连线上实例并尝试建库（例如 `psql -h 127.0.0.1 -p <线上端口> -d postgres -c "create database x"`）：应被拒绝（要密码）；按本页起的开发实例跑 `npm run test:integration` 应正常。
6. **回退。** 还原第 1 步保存的 `pg_hba.conf` 并 `pg_ctl reload`，把 `EVOLOOP_DATABASE_URL` 改回原值并重启协调服务；若数据有变化，按备份恢复。第 3 步之前的任何一步都不改线上实例。

## 还没验证的

- 第 2–5 步是否在这台机器的线上实例上按上述方式生效（含迁移是否需要超级用户）：没有执行，等维护者配置后才能验证。
- 仓库保护只证明会拒绝线上形态的服务器（在一次性集群里放一个叫 `evoloop` 的库来模拟，没有连接线上实例）。
