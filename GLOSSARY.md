# Skylight NAS hosting

Runs the Skylight server on a Synology NAS so claude.ai and OpenCode can use the family's Skylight from anywhere, behind a sign-in limited to Eric.

## Skylight

**Skylight account**:
The family's login at Skylight, an email and password.
_Avoid_: user, login

**Frame**:
One Skylight display device in the Skylight account.
_Avoid_: device, calendar

**Verification code**:
The one-time code Skylight sometimes emails during a Skylight sign-in.
_Avoid_: 2FA, OTP, login code

## Tools

**Tool**:
One named action the Skylight server offers to clients.
_Avoid_: command, function, endpoint, MCP

**Read tool**:
A tool that only looks at Skylight data.

**Write tool**:
A tool that changes Skylight data.

**Gated write tool**:
A write tool that has a confirm gate; other write tools run immediately.

**Confirm gate**:
The two-step check a gated write tool requires: a preview first, then a repeat call carrying the confirm token.
_Avoid_: confirmation, approval, elicitation

## Hosting

**Skylight server**:
The program that exposes Skylight to clients (skylight-mcp).
_Avoid_: MCP, the CLI, the npx thing

**Gateway**:
The part that lets clients reach the Skylight server over HTTPS.
_Avoid_: wrapper, bridge

**Auth proxy**:
The gatekeeper in front of the gateway that lets in only Eric's GitHub account.
_Avoid_: login, OAuth server

**Skylight sign-in**:
The Skylight server's signed-in state with the Skylight account, kept between restarts.
_Avoid_: session, auth

## Clients

**Client**:
An app that uses the Skylight server, such as claude.ai or OpenCode.
_Avoid_: connector, host

**Client token**:
The secret a client sends to the gateway on every request; each client has its own, so one can be revoked without the others.
_Avoid_: API key, password

**Connector**:
claude.ai's saved entry for the Skylight server's URL, where Eric signs in and switches individual tools on or off.
_Avoid_: integration, plugin

**MCP session**:
One client's open connection to the Skylight server; claude.ai may open a new one per chat.
_Avoid_: session (unqualified), conversation
