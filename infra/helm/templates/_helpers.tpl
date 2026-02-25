{{- define "stig.labels" -}}
app.kubernetes.io/name: azure-stig-dashboard
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "stig.selectorLabels" -}}
app.kubernetes.io/name: azure-stig-dashboard
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
