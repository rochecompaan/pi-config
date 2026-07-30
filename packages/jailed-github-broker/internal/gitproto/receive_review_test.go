package gitproto

import (
	"bytes"
	"strings"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
)

func TestParseReceivePackRejectsUnadvertisedRequestedCapability(t *testing.T) {
	raw := joinPackets(packet(sha1A+" "+sha1B+" refs/heads/feature\x00report-status unadvertised"), flush())
	result, err := ParseReceivePack(bytes.NewReader(raw), ReceiveOptions{
		MaxBytes:       4096,
		AdvertisedCaps: Capabilities{"report-status": ""},
	})
	if err == nil {
		t.Fatal("ParseReceivePack() error = nil")
	}
	assertNoForwardableReceiveResult(t, result)
}

func TestParseReceivePackRejectsUnadvertisedPushCertificate(t *testing.T) {
	raw := signedEnvelope("-----BEGIN PGP SIGNATURE-----", "-----END PGP SIGNATURE-----", nil, zero1+" "+sha1B+" refs/heads/feature\n")
	result, err := ParseReceivePack(bytes.NewReader(raw), receiveOptions(4096))
	if err == nil || !strings.Contains(err.Error(), "push certificate") {
		t.Fatalf("ParseReceivePack() error = %v, want unadvertised push certificate", err)
	}
	assertNoForwardableReceiveResult(t, result)
}

func TestParseReceivePackAppliesMainPolicyAfterShallowPrefix(t *testing.T) {
	raw := joinPackets(
		packet("shallow "+sha1A+"\n"),
		packet(sha1A+" "+sha1B+" refs/heads/main\x00report-status"),
		flush(),
	)
	options := receiveOptions(4096)
	options.Policy = config.DefaultPushPolicy()
	result, err := ParseReceivePack(fragmented(raw, 1), options)
	if err == nil || !strings.Contains(err.Error(), "refs/heads/main") {
		t.Fatalf("ParseReceivePack() error = %v, want main denial", err)
	}
	assertNoForwardableReceiveResult(t, result)
}

func TestParseReceivePackRejectsControlCharacterRefAndAmbiguousFlush(t *testing.T) {
	cases := map[string][]byte{
		"control ref":          joinPackets(packet(sha1A+" "+sha1B+" refs/heads/control\x1f\x00report-status"), flush()),
		"flush before command": joinPackets(packet("shallow "+sha1A+"\n"), flush()),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			result, err := ParseReceivePack(bytes.NewReader(raw), receiveOptions(4096))
			if err == nil {
				t.Fatal("ParseReceivePack() error = nil")
			}
			assertNoForwardableReceiveResult(t, result)
		})
	}
}

func TestParseReceivePackDefaultsToSHA1WhenObjectFormatIsAbsent(t *testing.T) {
	raw := joinPackets(packet(sha256A+" "+sha256B+" refs/heads/feature\x00report-status"), flush())
	result, err := ParseReceivePack(bytes.NewReader(raw), receiveOptions(4096))
	if err == nil {
		t.Fatal("ParseReceivePack() error = nil")
	}
	assertNoForwardableReceiveResult(t, result)
}

func TestParseReceivePackRequiresRequestedSHA256ObjectFormat(t *testing.T) {
	raw := joinPackets(packet(sha256A+" "+sha256B+" refs/heads/feature\x00report-status"), flush())
	result, err := ParseReceivePack(bytes.NewReader(raw), ReceiveOptions{
		MaxBytes: 4096,
		AdvertisedCaps: Capabilities{
			"report-status": "",
			"object-format": "sha256",
		},
	})
	if err == nil {
		t.Fatal("ParseReceivePack() error = nil")
	}
	assertNoForwardableReceiveResult(t, result)
}

func TestParseReceivePackRejectsObjectFormatWidthMismatch(t *testing.T) {
	raw := joinPackets(packet(sha1A+" "+sha1B+" refs/heads/feature\x00report-status object-format=sha256"), flush())
	result, err := ParseReceivePack(bytes.NewReader(raw), ReceiveOptions{
		MaxBytes: 4096,
		AdvertisedCaps: Capabilities{
			"report-status": "",
			"object-format": "sha256",
		},
	})
	if err == nil {
		t.Fatal("ParseReceivePack() error = nil")
	}
	assertNoForwardableReceiveResult(t, result)
}

func assertNoForwardableReceiveResult(t *testing.T, result ReceiveResult) {
	t.Helper()
	if result.Raw != nil || result.Updates != nil {
		t.Fatalf("result = %#v, want no forwardable result", result)
	}
}
