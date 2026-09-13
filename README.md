# opencode-codex-goal

OpenCode 1.x向けの，OpenAI Codex CLIのGoal continuationの考え方を移植したローカルPluginです．`/goal <objective>` でセッション単位のGoalを設定し，Goalがactiveの間は `session.idle` を使って自動的に次のturnを開始します．

このリポジトリはnpmパッケージとして公開するものではありません．GitHubからcloneした実体をOpenCodeのglobal plugin directoryへsymlinkして使います．

## 対応範囲

- OpenCode 1.xのV1 Plugin API向けです．OpenCode 2向けのAPIへ移行していません．
- `/goal`，`/goal pause`，`/goal resume`，`/goal clear`を提供します．
- Goal stateは現在のプロジェクトの `.opencode/goal/<sessionID>.json` に保存されます．global pluginとして導入しても，clone先の `~/.config/opencode/opencode-codex-goal/goal/` には保存されません．
- 成功した継続turn数に固定上限はありません．Goalが `complete`，`blocked`，`paused`，`waiting`，`cleared` になるまで継続します．transport/API/abort障害の失敗retryだけはbackoffと連続失敗上限で停止します．
- `goal_checkpoint`，`goal_complete`，`goal_blocked` はモデル側に提供され，pause/resume/clearはユーザーの `/goal` 操作です．
- objectiveとcompletion/blocked auditはsystem promptへ注入します．Qwen系などsingle-system-messageを要求するモデルでは，既存の先頭system messageへmergeします．
- `/goal` commandの実行時は内部のcontinuation templateを画面へ展開せず，簡潔な表示だけを返します．

## インストール

OpenCodeを終了してから，次を実行します．

```bash
git clone git@github.com:ITO1103/opencode-codex-goal.git \
  ~/.config/opencode/opencode-codex-goal
~/.config/opencode/opencode-codex-goal/install.sh
```

`install.sh` は次のsymlinkを作ります．

```text
~/.config/opencode/plugins/opencode-codex-goal.ts -> repository/plugin/goal.ts
~/.config/opencode/plugins/goalpkg              -> repository/plugin/goalpkg
~/.config/opencode/commands/goal.md             -> repository/command/goal.md
```

既存の通常ファイルや別のsymlinkは上書きしません．同じrepositoryを指すsymlinkだけは再実行しても安全です．別のGoal Pluginを既に導入している場合は，同じ `/goal` commandや同名toolsが競合する可能性があるため，重複導入しないでください．

## 更新とアンインストール

更新はclone先で行います．

```bash
git -C ~/.config/opencode/opencode-codex-goal pull
```

symlinkはclone先を指しているため，OpenCodeを再起動すれば更新内容が使われます．

```bash
~/.config/opencode/opencode-codex-goal/uninstall.sh
```

`uninstall.sh` はこのrepositoryを指す3つのsymlinkだけを削除します．別のPlugin，OpenCode設定，各プロジェクトの `.opencode/goal/` は削除しません．

## `/goal` の使い方

```text
/goal リポジトリのテストとドキュメントを確認して公開可能な状態にする
/goal
/goal pause
/goal resume
/goal clear
```

Goalを設定するとactive stateがsession IDごとに保存されます．通常のturnがidleになると，Pluginは同じsessionへ短いcontinuation messageを送り，system promptにはobjectiveとaudit templateを再注入します．同じsessionでpromptがin-flightの間，sessionがbusy/retryの間，またはcompaction中は重複したpromptを送信しません．モデルが実際の状態を確認して全要件を満たしたと判断したとき `goal_complete` を呼び，厳密なblocked auditを満たしてユーザー入力などなしには進められないとき `goal_blocked` を呼びます．意味のある中間成果は `goal_checkpoint` で記録できます．

自動継続の成功turn数はuncappedです．一方，SSE read timeout，ECONNRESET，abortなどのretryable errorは指数backoffで通常最大3回の連続失敗まで再試行し，超過すると `waiting` へ移ります．同じエラーが進捗なしで続く場合は2回で早期停止します．認証エラー，非retryable API error，未知の障害は `waiting` に移します．context overflowはcompaction完了まで `waiting` に保持します．明示的に停止する場合は `/goal pause` または `/goal clear` を使用してください．`waiting` からは `/goal resume` でretryカウンタと待機状態をリセットして再開できます．`blocked` はgoal自体の外部入力待ち，`paused` はユーザー停止，`waiting` はLLM/API障害による自動停止です．

## 開発と確認

```bash
npm install
npm run typecheck
npm test
```

OpenCodeの型定義はV1 APIの確認用にdev dependencyとして使用します．実際のPluginロードはOpenCode 1.xで行われ，runtimeの依存解決はOpenCodeのglobal config directoryにある依存関係の状態にも依存します．SSH越しの遅いローカルLLM endpointでは，timeout後に即時再送せず，保存された`nextRetryAt`と`waiting`状態を使ってループを抑止します．

## Continuation templateのライセンス

本リポジトリ自身のコードは `LICENSE` のMIT Licenseで公開します．`plugin/goalpkg/continuation.template.md` はOpenAI Codex CLIの公開Goal continuation templateを元にした改変物で，元リポジトリのApache License 2.0が適用されます．元ファイルのcopyrightと出典，改変内容はtemplateのprovenance commentと `NOTICE` に記載し，Apache License 2.0本文を `LICENSE-CODEX-APACHE-2.0` に保存しています．元ファイルのパスはCodex CLI側の更新で変わる可能性があるため，公開前にリンク先の現行ファイルとライセンスを再確認してください．

## 既知の注意

- OpenCode設定は起動時に読み込まれるため，install/update/uninstall後はOpenCodeを再起動してください．
- このPluginはOpenCode 1.xのV1 APIを対象にしており，OpenCode 2の `plugins` 設定やV2 APIは対象外です．
- 本リポジトリのテストはfake clientでhookとfilesystem stateを検証します．timeoutのbackoff/上限，resume，同時idle，compaction，プロセス再起動後の`nextRetryAt`復元まで検証しますが，実際のモデル推論，無限に続く実セッション，利用中のリモートLLM endpointまでは自動テストしません．

## 作成について

このプロジェクトはCodexによって作成されました．
