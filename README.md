# dsh-ssh-remote

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）直接操作一台远程 Linux 主机：通过本机 `ssh` 读取和修改远程文件、搜索代码、执行命令，用起来和本地工具没有区别。

> A DeepSeek Harness bundle that exposes six remote tools — run, read, write, edit, grep, glob — on a Linux host reached through your local SSH config. Setup instructions below are in Chinese.

> [!WARNING]
> **免责声明：本插件不提供任何安全功能。** 没有沙箱、没有权限校验、没有命令白名单、没有逐次确认；`remote_*` 工具以你的远程账号身份直接读文件、写文件、执行命令。哪些目录可以改、哪些命令能跑，需要你自己把握。

## 为什么做这个

DSH 桌面端只有 macOS 和 Windows，没有 Linux 版；而日常写代码的机器往往是一台 Linux 工作站。这个插件不搬运整个 harness，只把模型最需要的六件事接到 SSH 上，让「本机 DSH + 远程 Linux」组成一套完整的 vibe coding 环境。

## 工具

| 工具 | 作用 |
| --- | --- |
| `remote_bash` | 在远程登录环境下执行命令，支持 `cwd`、超时、退出码 |
| `remote_read` | 按行号读取远程文本，支持 `offset`/`limit`，尾部报告总行数 |
| `remote_write` | 创建或原子替换远程文件，自动建父目录、保留权限 |
| `remote_edit` | 字面替换，唯一性校验、原子写回、保留权限 |
| `remote_grep` | 远程 ripgrep 搜索，支持 include 过滤、遵守 `.gitignore` |
| `remote_glob` | 远程文件匹配，最多返回 500 条 |

插件还会注册一段系统提示，明确「这台 Linux 上的工作走 `remote_*`，本机工具只碰 Mac」，避免模型误用本地工具去改远程文件。

## 安装

```bash
git clone git@github.com:<you>/dsh-ssh-remote.git
```

然后在 DSH 里对 agent 说一句：

> 把 `~/code/dsh-ssh-remote` 作为 bundle 安装到当前 profile 并启用。

agent 会调用 `plugin_manager` 的 `install_bundle`，把该目录 link 进 `~/.dsh/profiles/<profile>/package.json` 并登记到 bundle 列表，安装后立即生效，重启仍然有效。

> 安装是「目录链接」，所以不要移动或删除这个仓库目录；移动后需要重新安装。

## 配置免密 SSH

插件用 `BatchMode=yes` 调 ssh：只要远端要求输入密码或口令，调用就会直接失败，而不是卡住。所以先把「无交互登录」跑通。

### 1. 在本机生成密钥（已有可跳过）

```bash
ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519 -C "$(whoami)@$(hostname)"
```

密钥带口令更安全，配合 ssh-agent / macOS 钥匙串即可无感使用（见第 4 步）。

### 2. 把公钥装到远程主机

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub Linux
```

如果本机没有 `ssh-copy-id`，用等价的手工写法：

```bash
cat ~/.ssh/id_ed25519.pub | ssh Linux \
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

### 3. 写 `~/.ssh/config`

`Host` 后面的别名就是插件配置里的 `host`：

```sshconfig
Host Linux
  HostName 192.168.1.20
  User zrt
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  ServerAliveInterval 30
```

`IdentitiesOnly yes` 可以避免 agent 里一堆密钥被依次试一遍（远程会报 `Too many authentication failures`）。

### 4. 密钥有口令时，交给 ssh-agent

macOS：

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

同时在 `~/.ssh/config` 的 Host 段里加：

```sshconfig
  AddKeysToAgent yes
  UseKeychain yes
```

Linux 客户端：

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
```

### 5. 验证「真的不用交互」

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 Linux 'echo ok'
```

必须直接输出 `ok`，不出现任何提示。这一条通过，插件就能工作。

### 6. 排错

| 现象 | 处理 |
| --- | --- |
| `Permission denied (publickey)` | `ssh -v Linux` 看实际尝试了哪把钥匙；确认 `IdentityFile` 写对 |
| 仍然弹密码 | 公钥没进 `authorized_keys`，或 sshd 关了 `PubkeyAuthentication` |
| `bad permissions` | `chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~` |
| 登录成功但立刻断开 | 家目录或 `.ssh` 对 group/other 可写，sshd 会拒绝 |
| `Too many authentication failures` | 加 `IdentitiesOnly yes` |
| 每次都要输口令 | 没跑 `ssh-add --apple-use-keychain`，或 config 里少了 `UseKeychain yes` |
| 想更收紧权限 | 在 `authorized_keys` 里给这把钥匙加 `from="..."`、`command="..."` 限制 |

## 插件配置

默认配置在 bundle 的 `cordis.patch.yml` 里，覆盖写在 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: ssh-remote
  config:
    host: Linux          # ~/.ssh/config 里的 Host 别名
    root: ~/projects     # 相对路径的基准目录，默认 ~
    bashTimeoutMs: 120000
    maxOutputChars: 30000
```

- `host`：SSH 别名，默认 `Linux`。
- `root`：`remote_*` 工具的相对路径基准。把它指到常用项目目录，模型就能直接写 `src/main.py` 这种相对路径。
- `bashTimeoutMs`：`remote_bash` 的默认超时；单次调用可用 `timeoutMs` 覆盖。
- `maxOutputChars`：单次工具结果回填给模型的字符上限。

## 工作原理

每个工具调用就是一次 `ssh` 子进程：

- 脚本通过 stdin 交给远端 `bash -s`，路径按 POSIX 单引号转义，不拼接不可信字符串；
- 文件内容以 base64 传输，避免引号、换行、二进制问题；
- 写入先落在同目录临时文件，再 `mv` 覆盖，并用 `chmod --reference` 保留原权限；
- 连接复用 `ControlMaster`，socket 在 `/tmp/dsh-ssh-<uid>/%C`，多次调用只有第一次付握手成本；
- 读取用一次 `awk` 扫描同时拿到窗口内容和总行数，只传需要的行。

## 安全边界

- 远程命令和写入使用**远程账号的权限**执行，没有额外沙箱；本机的 `workspace-write` 策略不约束远程主机。
- 插件直接调用 `ssh`，不经过本机 bash 沙箱，因此远程改动不受本机审批流程覆盖。
- 需要更细的控制时，可以在 `authorized_keys` 里用 `from=`、`command=`、`permitopen=` 限制这把钥匙的能力。
- SSH 私钥、`authorized_keys` 都不要提交到仓库。

## 自检

```bash
node test.mjs                 # 默认测 Linux 这个别名
TEST_HOST=myhost node test.mjs
```

脚本会在远端 `/tmp/dsh-ssh-remote-test` 下读写，结束时把目录改名收尾。17 项检查覆盖：命令执行、退出码、超时、写入建目录、分页读取、越界与缺失文件、二进制拒绝、替换唯一性、`replace_all`、Unicode、权限保留、grep/glob、相对 root 路径。

## 环境要求

- 远端：`bash`、`awk`、GNU coreutils（`base64`、`stat -c`、`chmod --reference`）、`ripgrep`。
- 本机：macOS 或 Linux，OpenSSH 客户端，Node.js 18+（仅自检脚本需要）。
- DSH 0.2.x；纯 Host bundle，无第三方依赖，不需要构建。

## 许可证

[MIT](LICENSE) © 2026 Ruitong Zhang
