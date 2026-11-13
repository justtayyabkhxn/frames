<template>
  <div class="star-rating" role="radiogroup" :aria-label="t('memories', 'Rating')" @mouseleave="hover = 0">
    <button
      v-for="n in 5"
      :key="n"
      type="button"
      role="radio"
      class="star"
      :class="{ on: n <= (hover || props.value) }"
      :aria-checked="n === props.value"
      :aria-label="n === props.value ? t('memories', 'Clear rating') : t('memories', '{n} stars', { n })"
      :disabled="props.readonly"
      @mouseenter="hover = props.readonly ? 0 : n"
      @click="emit('change', n === props.value ? 0 : n)"
    >
      <StarIcon v-if="n <= (hover || props.value)" :size="props.size" />
      <StarOutlineIcon v-else :size="props.size" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { t } from '@services/l10n';
import StarIcon from 'vue-material-design-icons/Star.vue';
import StarOutlineIcon from 'vue-material-design-icons/StarOutline.vue';

const props = withDefaults(defineProps<{ value: number; readonly?: boolean; size?: number }>(), { size: 22 });
const emit = defineEmits<{ change: [rating: number] }>();
const hover = ref(0);
</script>

<style lang="scss" scoped>
.star-rating {
  display: inline-flex;
  gap: 2px;
}
.star {
  all: unset;
  cursor: pointer;
  color: var(--color-text-maxcontrast);
  line-height: 0;
  border-radius: 4px;
  &.on {
    color: #f5a623;
  }
  &:focus-visible {
    outline: 2px solid var(--color-primary-element);
  }
  &:disabled {
    cursor: default;
  }
}
</style>
