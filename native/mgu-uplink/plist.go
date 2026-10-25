package main

// XML property lists, the message format of an iPhone's lockdown service:
// dict, array, string, data, integer, real, true/false and date. Values
// map to map[string]interface{}, []interface{}, string, []byte, int64 (or
// uint64 above int64), float64, bool; a date stays its string. lockdownd
// answers in the format it is asked in, so XML is all this needs. Tested
// in iphone_test.go.

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

const plistHeader = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
`

func plistEncode(v interface{}) ([]byte, error) {
	var b bytes.Buffer
	b.WriteString(plistHeader)
	if err := plistValue(&b, v); err != nil {
		return nil, err
	}
	b.WriteString("</plist>\n")
	return b.Bytes(), nil
}

func plistValue(b *bytes.Buffer, v interface{}) error {
	switch x := v.(type) {
	case map[string]interface{}:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteString("<dict>\n")
		for _, k := range keys {
			b.WriteString("<key>")
			xml.EscapeText(b, []byte(k))
			b.WriteString("</key>\n")
			if err := plistValue(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteString("</dict>\n")
	case []interface{}:
		b.WriteString("<array>\n")
		for _, e := range x {
			if err := plistValue(b, e); err != nil {
				return err
			}
		}
		b.WriteString("</array>\n")
	case string:
		b.WriteString("<string>")
		xml.EscapeText(b, []byte(x))
		b.WriteString("</string>\n")
	case []byte:
		fmt.Fprintf(b, "<data>%s</data>\n", base64.StdEncoding.EncodeToString(x))
	case bool:
		if x {
			b.WriteString("<true/>\n")
		} else {
			b.WriteString("<false/>\n")
		}
	case int:
		fmt.Fprintf(b, "<integer>%d</integer>\n", x)
	case int64:
		fmt.Fprintf(b, "<integer>%d</integer>\n", x)
	case uint64:
		fmt.Fprintf(b, "<integer>%d</integer>\n", x)
	case float64:
		fmt.Fprintf(b, "<real>%s</real>\n", strconv.FormatFloat(x, 'g', -1, 64))
	default:
		return fmt.Errorf("plist: cannot encode %T", v)
	}
	return nil
}

// plistDecode parses an XML property list.
func plistDecode(data []byte) (interface{}, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	d.Strict = false
	for {
		t, err := d.Token()
		if err != nil {
			return nil, fmt.Errorf("plist: %v", err)
		}
		if se, ok := t.(xml.StartElement); ok {
			if se.Name.Local == "plist" {
				continue
			}
			return plistElement(d, se, 0)
		}
	}
}

func plistElement(d *xml.Decoder, se xml.StartElement, depth int) (interface{}, error) {
	if depth > 32 {
		return nil, fmt.Errorf("plist: nested too deep")
	}
	switch se.Name.Local {
	case "dict":
		m := map[string]interface{}{}
		key := ""
		haveKey := false
		for {
			t, err := d.Token()
			if err != nil {
				return nil, fmt.Errorf("plist: %v", err)
			}
			switch e := t.(type) {
			case xml.StartElement:
				if e.Name.Local == "key" {
					s, err := plistText(d)
					if err != nil {
						return nil, err
					}
					key, haveKey = s, true
					continue
				}
				if !haveKey {
					return nil, fmt.Errorf("plist: dict value without a key")
				}
				v, err := plistElement(d, e, depth+1)
				if err != nil {
					return nil, err
				}
				m[key] = v
				haveKey = false
			case xml.EndElement:
				return m, nil
			}
		}
	case "array":
		var a []interface{}
		for {
			t, err := d.Token()
			if err != nil {
				return nil, fmt.Errorf("plist: %v", err)
			}
			switch e := t.(type) {
			case xml.StartElement:
				v, err := plistElement(d, e, depth+1)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			case xml.EndElement:
				return a, nil
			}
		}
	case "true", "false":
		if err := d.Skip(); err != nil {
			return nil, err
		}
		return se.Name.Local == "true", nil
	}
	s, err := plistText(d)
	if err != nil {
		return nil, err
	}
	switch se.Name.Local {
	case "string", "date":
		return s, nil
	case "data":
		b, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(s), ""))
		if err != nil {
			return nil, fmt.Errorf("plist: data: %v", err)
		}
		return b, nil
	case "integer":
		s = strings.TrimSpace(s)
		if i, err := strconv.ParseInt(s, 10, 64); err == nil {
			return i, nil
		}
		u, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("plist: integer %q", s)
		}
		return u, nil
	case "real":
		f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			return nil, fmt.Errorf("plist: real %q", s)
		}
		return f, nil
	}
	return nil, fmt.Errorf("plist: unknown element <%s>", se.Name.Local)
}

// plistText reads the character data up to the current element's end.
func plistText(d *xml.Decoder) (string, error) {
	var b strings.Builder
	for {
		t, err := d.Token()
		if err == io.EOF {
			return "", fmt.Errorf("plist: unexpected end")
		}
		if err != nil {
			return "", fmt.Errorf("plist: %v", err)
		}
		switch e := t.(type) {
		case xml.CharData:
			b.Write(e)
		case xml.EndElement:
			return b.String(), nil
		case xml.StartElement:
			return "", fmt.Errorf("plist: <%s> inside a scalar", e.Name.Local)
		}
	}
}
