package client

import "strings"

func validRepositorySlug(repository string) bool {
	owner, name, found := strings.Cut(repository, "/")
	if !found || strings.Contains(name, "/") || len(owner) == 0 || len(owner) > 39 || len(name) == 0 || len(name) > 100 || name == "." || name == ".." {
		return false
	}
	if owner[0] == '-' || owner[len(owner)-1] == '-' || strings.Contains(owner, "--") {
		return false
	}
	for index := range owner {
		if !asciiAlphaNumeric(owner[index]) && owner[index] != '-' {
			return false
		}
	}
	for index := range name {
		character := name[index]
		if !asciiAlphaNumeric(character) && character != '.' && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func asciiAlphaNumeric(character byte) bool {
	return character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9'
}
