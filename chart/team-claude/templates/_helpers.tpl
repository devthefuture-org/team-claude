{{/*
Common name helpers.
*/}}

{{- define "team-claude.name" -}}
{{- $session := .Values.session.name | default .Release.Name -}}
{{- printf "session-%s" $session | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "team-claude.fullname" -}}
{{- include "team-claude.name" . -}}
{{- end -}}

{{- define "team-claude.sessionName" -}}
{{- .Values.session.name | default .Release.Name -}}
{{- end -}}

{{- define "team-claude.labels" -}}
app.kubernetes.io/name: team-claude
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: team-claude
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
team-claude/session: {{ include "team-claude.sessionName" . | quote }}
{{- if .Values.session.user }}
team-claude/user: {{ .Values.session.user | quote }}
{{- end }}
{{- end -}}

{{- define "team-claude.selectorLabels" -}}
app.kubernetes.io/name: team-claude
app.kubernetes.io/instance: {{ .Release.Name }}
team-claude/session: {{ include "team-claude.sessionName" . | quote }}
{{- end -}}

{{- define "team-claude.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{ include "team-claude.fullname" . }}
{{- else -}}
default
{{- end -}}
{{- end -}}

{{/*
Host derivations. Use explicit hosts if set, otherwise compose from session + domain.
*/}}

{{- define "team-claude.codeServerHost" -}}
{{- if .Values.hosts.codeServer -}}
{{ .Values.hosts.codeServer }}
{{- else -}}
{{ printf "code-%s.%s" (include "team-claude.sessionName" .) .Values.domain }}
{{- end -}}
{{- end -}}

{{- define "team-claude.daemonHost" -}}
{{- if .Values.hosts.daemon -}}
{{ .Values.hosts.daemon }}
{{- else -}}
{{ printf "team-%s.%s" (include "team-claude.sessionName" .) .Values.domain }}
{{- end -}}
{{- end -}}

{{/*
Restricted securityContext, used by every container that doesn't need to bind
privileged ports. The devcontainer container switches to runAsUser: 0 when
ssh.enabled because sshd needs to bind port 22.
*/}}

{{- define "team-claude.restrictedSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
allowPrivilegeEscalation: false
capabilities:
  drop:
    - ALL
seccompProfile:
  type: RuntimeDefault
{{- end -}}
