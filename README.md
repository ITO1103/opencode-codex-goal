# opencode-codex-goal

OpenCode 1.x向けの、OpenAI Codex CLIのGoal continuationの考え方を移植したローカルPluginです。`/goal <objective>` でセッション単位のGoalを設定し、Goalがactiveの間は `session.idle` を使って自動的に次のturnを開始します。

このリポジトリはnpmパッケージとして公開するものではありません。GitHubからcloneした実体をOpenCodeのglobal plugin directoryへsymlinkして使います。

## 対応範囲

- OpenCode 1.xのV1 Plugin API向けです。OpenCode 2向けのAPIへ移行していません。
- `/goal`、`/goal pause`、`/goal resume`、`/goal clear`を提供します。
- Goal stateは現在のプロジェクトの `.opencode/goal/<sessionID>.json` に保存されます。global pluginとして導入しても、clone先の `~/.config/opencode/opencode-codex-goal/goal/` には保存されません。
- 固定turn数の上限はありません。Goalが `complete`、`blocked`、`paused`、`cleared` になるまで継続します。
- `goal_complete` と `goal_blocked` はモデル側にだけ提供され、pause/resume/clearはユーザーの `/goal` 操作です。
- objectiveとcompletion/blocked auditはsystem promptへ注入します。Qwen系などsingle-system-messageを要求するモデルでは、既存の先頭system messageへmergeします。
- `/goal` commandの実行時は内部のcontinuation templateを画面へ展開せず、簡潔な表示だけを返します。

## インストール

OpenCodeを終了してから、次を実行します。

```bash
git clone git@github.com:ITO1103/opencode-codex-goal.git \
  ~/.config/opencode/opencode-codex-goal
~/.config/opencode/opencode-codex-goal/install.sh
```

`install.sh` は次のsymlinkを作ります。

```text
~/.config/opencode/plugins/opencode-codex-goal.ts -> repository/plugin/goal.ts
~/.config/opencode/plugins/goalpkg              -> repository/plugin/goalpkg
~/.config/opencode/commands/goal.md             -> repository/command/goal.md
```

既存の通常ファイルや別のsymlinkは上書きしません。同じrepositoryを指すsymlinkだけは再実行しても安全です。別のGoal Pluginを既に導入している場合は、同じ `/goal` commandや同名toolsが競合する可能性があるため、重複導入しないでください。

## 更新とアンインストール

更新はclone先で行います。

```bash
git -C ~/.config/opencode/opencode-codex-goal pull
```

symlinkはclone先を指しているため、OpenCodeを再起動すれば更新内容が使われます。

```bash
~/.config/opencode/opencode-codex-goal/uninstall.sh
```

`uninstall.sh` はこのrepositoryを指す3つのsymlinkだけを削除します。別のPlugin、OpenCode設定、各プロジェクトの `.opencode/goal/` は削除しません。

## `/goal` の使い方

```text
/goal リポジトリのテストとドキュメントを確認して公開可能な状態にする
/goal
/goal pause
/goal resume
/goal clear
```

Goalを設定するとactive stateがsession IDごとに保存されます。通常のturnがidleになると、Pluginは同じsessionへ短いcontinuation messageを送り、system promptにはobjectiveとaudit templateを再注入します。モデルが実際の状態を確認して全要件を満たしたと判断したとき `goal_complete` を呼び、厳密なblocked auditを満たしてユーザー入力などなしには進められないとき `goal_blocked` を呼びます。

自動継続はuncappedです。activeのままでは推論やAPI呼び出しが続くため、コスト、レート制限、ローカルマシンの負荷に注意してください。必要なときは `/goal pause` または `/goal clear` を使ってください。モデルやAPIの一時的なtransport/auth errorでは自動的にblockedにせず、再開可能なactive stateを維持します。明確なmodel/turn errorだけが自動的にblockedになります。

## 開発と確認

```bash
npm install
npm run typecheck
npm test
```

OpenCodeの型定義はV1 APIの確認用にdev dependencyとして使用します。実際のPluginロードはOpenCode 1.xで行われ、runtimeの依存解決はOpenCodeのglobal config directoryにある依存関係の状態にも依存します。

## Continuation templateのライセンス

`plugin/goalpkg/continuation.template.md` はOpenAI Codex CLIの公開Goal continuation templateを元にした改変物です。元リポジトリは現在Apache License 2.0で公開されており、元ファイルのcopyrightと出典、改変内容をtemplateのprovenance commentと `NOTICE` に記載しています。元ファイルのパスはCodex CLI側の更新で変わる可能性があるため、公開前にリンク先の現行ファイルとライセンスを再確認してください。

## 既知の注意

- OpenCode設定は起動時に読み込まれるため、install/update/uninstall後はOpenCodeを再起動してください。
- このPluginはOpenCode 1.xのV1 APIを対象にしており、OpenCode 2の `plugins` 設定やV2 APIは対象外です。
- 本リポジトリのテストはfake clientでhookとfilesystem stateを検証します。実際のモデル推論、無限に続く実セッション、利用中のローカルLLM endpointまでは自動テストしません。
