// YouTube Live連携を有効にする際に一度だけ手動で実行するセットアップスクリプト。
// ブラウザが開けるローカルPC等で実行する(ラズパイ上で実行する必要はない)。
//
// 事前準備:
//   1. Google Cloud Consoleで新規プロジェクトを作成し「YouTube Data API v3」を有効化
//   2. OAuth同意画面を設定(テスト/内部利用でよい)
//   3. OAuthクライアントID(種類: デスクトップアプリ)を作成し、client_id/client_secretを取得
//   4. 対象のYouTubeチャンネルでライブ配信を有効化(電話番号確認、反映まで最大24時間)
//
// 使い方:
//   YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... node bot/scripts/youtube-oauth-setup.js
//
// 表示された認可URLをブラウザで開いて許可すると、このスクリプトがrefresh_tokenを
// 標準出力に表示する。それを bot/.env の YOUTUBE_REFRESH_TOKEN に貼り付けること。

const http = require("http");

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "環境変数 YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET を指定して実行してください。"
  );
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/youtube");
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("以下のURLをブラウザで開いて、Googleアカウントでの許可を行ってください:\n");
console.log(authUrl.toString());
console.log(`\n許可後のリダイレクトを http://localhost:${REDIRECT_PORT} で待ち受け中...`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.end("認可に失敗しました。ターミナルを確認してください。");
    console.error(`認可に失敗: ${error}`);
    server.close();
    process.exit(1);
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok || !tokenJson.refresh_token) {
      throw new Error(
        tokenJson.error_description || tokenJson.error || "refresh_tokenを取得できませんでした"
      );
    }

    res.end("取得完了しました。ターミナルを確認してください。このタブは閉じて構いません。");
    console.log("\n取得成功。以下を bot/.env の YOUTUBE_REFRESH_TOKEN に設定してください:\n");
    console.log(tokenJson.refresh_token);
  } catch (err) {
    res.end("トークン取得に失敗しました。ターミナルを確認してください。");
    console.error(`トークン取得に失敗: ${err.message}`);
  } finally {
    server.close();
  }
});

server.listen(REDIRECT_PORT);
